import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // --- SYSTEM STATES ---
  const [engineActive, setEngineActive] = useState(false);
  const [isPoweringUp, setIsPoweringUp] = useState(false);
  const [uiVisible, setUiVisible] = useState(false);
  
  // --- TELEMETRY STATES (Persistent) ---
  const [speed, setSpeed] = useState(0);
  const [sweepSpeed, setSweepSpeed] = useState(0); 
  const [gpsStatus, setGpsStatus] = useState('searching'); 

  // Load from iPhone LocalStorage
  const [distance, setDistance] = useState(() => {
    const saved = parseFloat(localStorage.getItem('townace_distance'));
    return isNaN(saved) ? 0 : saved;
  });
  const [maxSpeed, setMaxSpeed] = useState(() => {
    const saved = parseFloat(localStorage.getItem('townace_maxspeed'));
    return isNaN(saved) ? 0 : saved;
  });
  const [fuel, setFuel] = useState(() => {
    const saved = parseFloat(localStorage.getItem('townace_fuel'));
    return isNaN(saved) ? 50 : saved;
  });
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('townace_theme');
    return saved !== null ? saved === 'true' : true;
  });

  // --- MODAL & UI STATES ---
  const [isFuelModalOpen, setIsFuelModalOpen] = useState(false);
  const [tempFuel, setTempFuel] = useState(50);
  const [ecoColor, setEcoColor] = useState('#3b82f6'); 

  // --- HARDWARE REFS ---
  const watchIdRef = useRef(null);
  const staleIntervalRef = useRef(null);
  const lastUpdateTimeRef = useRef(Date.now());
  const lastCoordsRef = useRef(null);
  const lastSpeedRef = useRef(0); 
  const wakeLockRef = useRef(null);
  const audioContextRef = useRef(null);

  const MAX_DIAL_SPEED = 160; 

  // --- AUTO-SAVE TO LOCAL STORAGE ---
  useEffect(() => localStorage.setItem('townace_distance', distance.toString()), [distance]);
  useEffect(() => localStorage.setItem('townace_maxspeed', maxSpeed.toString()), [maxSpeed]);
  useEffect(() => localStorage.setItem('townace_fuel', fuel.toString()), [fuel]);
  useEffect(() => localStorage.setItem('townace_theme', isDarkMode.toString()), [isDarkMode]);

  // --- VEHICLE MATH ---
  const getConsumptionRate = (currentSpeed) => {
    if (currentSpeed > 90) return 13;
    if (currentSpeed >= 60) return 14; 
    return 12; 
  };

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; 
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
  };

  // --- AUDIO ENGINE ---
  const playIgnitionTone = (freq, type, duration) => {
    try {
      if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioContextRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + duration);
    } catch (e) {}
  };

  // --- GPS TRACKING ENGINE ---
  const startGpsStream = () => {
    if (!navigator.geolocation) {
      setGpsStatus('lost');
      return;
    }
    setGpsStatus('searching');
    lastUpdateTimeRef.current = Date.now();

    staleIntervalRef.current = setInterval(() => {
      if (Date.now() - lastUpdateTimeRef.current > 2000) {
        setSpeed((prev) => {
          if (prev > 0) {
            const decayed = prev * 0.4;
            return decayed < 1 ? 0 : decayed;
          }
          return 0;
        });
        if (speed < 2) setEcoColor('#3b82f6');
      }
    }, 500);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsStatus('ready');
        lastUpdateTimeRef.current = Date.now(); 
        
        const rawSpeed = pos.coords.speed;
        let kmh = rawSpeed && rawSpeed > 0.25 ? rawSpeed * 3.6 : 0;
        
        let acceleration = kmh - lastSpeedRef.current;
        if (kmh < 3) {
          setEcoColor('#3b82f6'); 
        } else if (acceleration > 1.2) {
          setEcoColor('#3b82f6'); 
        } else if (acceleration < -1.2) {
          setEcoColor(isDarkMode ? '#ffffff' : '#52525b'); 
        } else {
          setEcoColor('#10b981'); 
        }
        
        lastSpeedRef.current = kmh;
        setSpeed(kmh);
        if (kmh > maxSpeed) setMaxSpeed(kmh);

        if (lastCoordsRef.current) {
          const d = calculateDistance(lastCoordsRef.current.latitude, lastCoordsRef.current.longitude, pos.coords.latitude, pos.coords.longitude);
          if (d < 0.1 && kmh > 0) {
            setDistance((prev) => prev + d);
            setFuel((prevFuel) => Math.max(0, prevFuel - (d / getConsumptionRate(kmh))));
          }
        }
        lastCoordsRef.current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      },
      () => setGpsStatus('lost'),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
  };

  const stopGpsStream = () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    if (staleIntervalRef.current) clearInterval(staleIntervalRef.current);
    lastCoordsRef.current = null;
    lastSpeedRef.current = 0;
    setSpeed(0);
    setEcoColor('#3b82f6');
  };

  const toggleEngineState = () => {
    if (!engineActive && !isPoweringUp) {
      setIsPoweringUp(true);
      playIgnitionTone(260, 'sawtooth', 0.4);
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(lock => { wakeLockRef.current = lock; }).catch(() => {});
      
      setEcoColor('#3b82f6'); 
      setTimeout(() => setSweepSpeed(MAX_DIAL_SPEED), 100);
      setTimeout(() => setSweepSpeed(0), 750);

      setTimeout(() => {
        setEngineActive(true);
        setUiVisible(true);
        setIsPoweringUp(false);
        startGpsStream();
      }, 1200);

    } else if (engineActive) {
      playIgnitionTone(140, 'sine', 0.5);
      if (wakeLockRef.current) { wakeLockRef.current.release(); wakeLockRef.current = null; }
      stopGpsStream();
      setUiVisible(false);
      setTimeout(() => setEngineActive(false), 550);
    }
  };

  const handleTripReset = () => {
    setDistance(0);
    setMaxSpeed(0);
  };

  useEffect(() => {
    return () => { stopGpsStream(); if (wakeLockRef.current) wakeLockRef.current.release(); };
  }, []);

  // --- DYNAMIC THEME VARIABLES ---
  const theme = {
    bg: isDarkMode ? '#000000' : '#f4f4f5', 
    text: isDarkMode ? '#ffffff' : '#18181b',
    muted: isDarkMode ? '#71717a' : '#71717a',
    cardBg: isDarkMode ? 'rgba(24,24,27,0.8)' : '#ffffff',
    cardBorder: isDarkMode ? 'rgba(63,63,70,0.4)' : 'rgba(212,212,216,0.8)',
    shadow: isDarkMode ? '0 15px 30px rgba(0,0,0,0.9)' : '0 10px 20px rgba(0,0,0,0.05)',
    btnBg: isDarkMode ? 'rgba(39,39,42,0.6)' : '#e4e4e7',
  };

  const activeSpeed = isPoweringUp ? sweepSpeed : speed;
  const activeFuelBars = Math.ceil((fuel / 50) * 6);
  const estimatedRange = fuel * getConsumptionRate(speed);

  return (
    <>
      {/* --- WARNING SCREEN --- */}
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: '#000000', zIndex: 9999,
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '20px', textAlign: 'center', color: '#ffffff'
      }} className="portrait-warning">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '16px' }}>
          <path d="M21 2v6h-6"></path>
          <path d="M21 13a9 9 0 1 1-3-7.7L21 8"></path>
        </svg>
        <h2 className="font-digital" style={{ fontSize: '24px', letterSpacing: '4px', margin: 0, color: '#3b82f6' }}>TURN DEVICE</h2>
        <p style={{ fontSize: '14px', color: '#a1a1aa', marginTop: '16px' }}>Please rotate your iPhone horizontally.</p>
      </div>

      <div style={{
        position: 'absolute', inset: 0, width: '100vw', height: '100dvh', flexDirection: 'column', 
        justifyContent: 'space-between', boxSizing: 'border-box', zIndex: 1, backgroundColor: theme.bg,
        padding: '16px max(32px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left))',
        transition: 'background-color 0.4s ease'
      }} className="main-dashboard-layout">
        
        {/* --- FULL SCREEN ECO GLOW --- */}
        <div style={{
          position: 'absolute', inset: 0, backgroundColor: engineActive ? ecoColor : 'transparent',
          opacity: isDarkMode ? 0.05 : 0.02, transition: 'background-color 1.5s ease-in-out', pointerEvents: 'none', zIndex: 0
        }} />

        {/* --- TOP HEADER --- */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', zIndex: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div>
              <h1 className="font-digital" style={{ margin: 0, fontSize: '18px', letterSpacing: '4px', color: theme.muted, fontWeight: 'bold' }}>TOWNACE</h1>
              <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: theme.muted, letterSpacing: '1px', fontWeight: 'bold', fontFamily: 'system-ui, sans-serif' }}>
                トヨタ タウンエース DX
              </p>
            </div>
            
            {/* DAY/NIGHT SVG TOGGLE */}
            <button 
              onClick={() => setIsDarkMode(!isDarkMode)}
              style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, color: theme.text, borderRadius: '12px', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.3s' }}
            >
              {isDarkMode ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"></circle>
                  <line x1="12" y1="1" x2="12" y2="3"></line>
                  <line x1="12" y1="21" x2="12" y2="23"></line>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                  <line x1="1" y1="12" x2="3" y2="12"></line>
                  <line x1="21" y1="12" x2="23" y2="12"></line>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
              )}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '8px 20px', borderRadius: '14px', opacity: engineActive ? 1 : 0.2, transition: 'all 0.5s ease' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: '10px', color: theme.muted, textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: '1px' }}>GPS</span>
              <span className="font-digital" style={{ fontSize: '14px', fontWeight: 'bold', color: theme.text }}>
                {!engineActive ? 'OFF' : gpsStatus === 'ready' ? 'READY' : gpsStatus === 'searching' ? 'SEARCHING' : 'LOST'}
              </span>
            </div>
            <div style={{ width: '14px', height: '14px', borderRadius: '50%', transition: 'all 0.4s ease', backgroundColor: !engineActive ? theme.muted : gpsStatus === 'ready' ? '#10b981' : gpsStatus === 'searching' ? '#f59e0b' : '#ef4444', boxShadow: engineActive && gpsStatus === 'ready' ? '0 0 12px #10b981' : 'none' }} />
          </div>
        </div>

        {/* --- MAIN MATRIX --- */}
        <div style={{ display: 'flex', flex: 1, width: '100%', alignItems: 'center', justifyContent: 'space-between', maxWidth: '1200px', margin: '0 auto', boxSizing: 'border-box', zIndex: 10 }}>
          
          {/* LEFT CARDS */}
          <div className="fade-in-ui" style={{ width: '28%', display: 'flex', flexDirection: 'column', gap: '16px', justifyContent: 'center', opacity: uiVisible ? 1 : 0, transform: uiVisible ? 'translateX(0)' : 'translateX(-40px)' }}>
            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '16px 24px', borderRadius: '20px', position: 'relative', boxShadow: theme.shadow, transition: 'all 0.4s' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '6px', height: '100%', backgroundColor: '#ef4444', borderRadius: '20px 0 0 20px' }} />
              <p style={{ margin: 0, fontSize: '14px', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>MAX SPEED</p>
              <p style={{ margin: '4px 0 0 0', fontSize: '36px', color: theme.text, fontWeight: 'bold' }}><span className="font-digital">{Math.round(maxSpeed)}</span><span style={{ fontSize: '14px', color: theme.muted, marginLeft: '6px', fontWeight: 'bold' }}>KM/H</span></p>
            </div>

            <div onClick={() => { setTempFuel(Math.round(fuel)); setIsFuelModalOpen(true); }} style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '16px 24px', borderRadius: '20px', position: 'relative', boxShadow: theme.shadow, cursor: 'pointer', transition: 'all 0.4s' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '6px', height: '100%', backgroundColor: '#f59e0b', borderRadius: '20px 0 0 20px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '14px', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>FUEL</p>
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
                {[...Array(6)].map((_, i) => (
                  <div key={i} style={{ height: '10px', flex: 1, borderRadius: '4px', transition: 'background-color 0.5s ease', backgroundColor: i < activeFuelBars ? (activeFuelBars <= 1 ? '#ef4444' : '#f59e0b') : theme.btnBg }} />
                ))}
              </div>
            </div>
          </div>

          {/* CENTER: MASSIVE DIGITAL READOUT */}
          <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            
            {/* Core Speed Glow - Tighter blur, higher opacity for visibility without glare */}
            <div style={{ position: 'absolute', width: '260px', height: '160px', borderRadius: '50%', backgroundColor: engineActive ? ecoColor : 'transparent', filter: 'blur(55px)', opacity: isDarkMode ? 0.45 : 0.7, transition: 'background-color 1.5s ease-in-out', zIndex: 0 }} />

            <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span className="font-digital" style={{ 
                fontSize: '160px', fontWeight: '900', letterSpacing: '-6px', margin: 0, padding: 0, lineHeight: 0.9, 
                color: !engineActive && !isPoweringUp ? theme.muted : theme.text, transition: 'color 0.4s ease',
                textShadow: engineActive && isDarkMode ? '0 0 30px rgba(255,255,255,0.1)' : 'none' 
              }}>
                {Math.round(activeSpeed)}
              </span>
              <span style={{ fontSize: '18px', letterSpacing: '8px', color: engineActive ? theme.muted : theme.cardBorder, fontWeight: 'bold', marginTop: '8px' }}>KM/H</span>
            </div>
          </div>

          {/* RIGHT CARDS */}
          <div className="fade-in-ui" style={{ width: '28%', display: 'flex', flexDirection: 'column', gap: '16px', justifyContent: 'center', opacity: uiVisible ? 1 : 0, transform: uiVisible ? 'translateX(0)' : 'translateX(40px)' }}>
            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '16px 24px', borderRadius: '20px', position: 'relative', boxShadow: theme.shadow, transition: 'all 0.4s' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '6px', height: '100%', backgroundColor: '#3b82f6', borderRadius: '20px 0 0 20px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '14px', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>TRIP</p>
                <button onClick={handleTripReset} style={{ background: theme.btnBg, border: 'none', color: theme.text, fontSize: '11px', fontWeight: 'bold', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer' }}>RESET</button>
              </div>
              <p style={{ margin: '4px 0 0 0', fontSize: '36px', color: theme.text, fontWeight: 'bold' }}><span className="font-digital">{distance.toFixed(1)}</span><span style={{ fontSize: '14px', color: theme.muted, marginLeft: '6px', fontWeight: 'bold' }}>KM</span></p>
            </div>

            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '16px 24px', borderRadius: '20px', position: 'relative', boxShadow: theme.shadow, transition: 'all 0.4s' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '6px', height: '100%', backgroundColor: '#10b981', borderRadius: '20px 0 0 20px' }} />
              <p style={{ margin: 0, fontSize: '14px', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>EST RANGE</p>
              <p style={{ margin: '4px 0 0 0', fontSize: '36px', color: theme.text, fontWeight: 'bold' }}><span className="font-digital">{Math.round(estimatedRange)}</span><span style={{ fontSize: '14px', color: theme.muted, marginLeft: '6px', fontWeight: 'bold' }}>KM</span></p>
            </div>
          </div>

        </div>

        {/* --- BOTTOM CONTROL --- */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-start', zIndex: 20 }}>
          <button onClick={toggleEngineState} disabled={isPoweringUp} style={{ 
            background: isPoweringUp ? theme.btnBg : engineActive ? 'rgba(239,68,68,0.1)' : theme.cardBg, 
            border: `2px solid ${engineActive ? '#ef4444' : theme.cardBorder}`, 
            color: isPoweringUp ? theme.muted : engineActive ? '#ef4444' : theme.text, 
            padding: '10px 24px', borderRadius: '40px', fontSize: '11px', fontWeight: 'bold', letterSpacing: '2px', 
            cursor: isPoweringUp ? 'wait' : 'pointer', transition: 'all 0.4s ease', outline: 'none', 
            boxShadow: engineActive && isDarkMode ? '0 0 15px rgba(239,68,68,0.2)' : 'none' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isPoweringUp && <div className="animate-spin-fast" style={{ width: '12px', height: '12px', border: '2px solid #f59e0b', borderTopColor: 'transparent', borderRadius: '50%' }} />}
              <span className="font-digital">{isPoweringUp ? 'STARTING...' : engineActive ? 'ENG OFF' : 'ENG ON'}</span>
            </div>
          </button>
        </div>

        {/* --- FUEL OVERLAY MODAL --- */}
        {isFuelModalOpen && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: isDarkMode ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)', backdropFilter: 'blur(15px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, borderRadius: '24px', padding: '32px', width: '320px', textAlign: 'center', boxShadow: theme.shadow }}>
              <h2 className="font-digital" style={{ margin: '0 0 20px 0', fontSize: '18px', letterSpacing: '2px', color: '#f59e0b' }}>ADJUST FUEL</h2>
              <div style={{ fontSize: '56px', color: theme.text, fontWeight: 'bold', marginBottom: '24px' }}><span className="font-digital">{tempFuel}</span><span style={{ fontSize: '20px', color: theme.muted }}>L</span></div>
              <input type="range" min="0" max="50" value={tempFuel} onChange={(e) => setTempFuel(Number(e.target.value))} style={{ width: '100%', marginBottom: '32px', accentColor: '#f59e0b' }} />
              <div style={{ display: 'flex', gap: '16px' }}>
                <button onClick={() => setIsFuelModalOpen(false)} style={{ flex: 1, padding: '14px', background: theme.btnBg, border: 'none', color: theme.text, borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>CANCEL</button>
                <button onClick={() => { setFuel(tempFuel); setIsFuelModalOpen(false); }} style={{ flex: 1, padding: '14px', background: '#f59e0b', border: 'none', color: '#000000', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>SAVE</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}