import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';

// --- OPTIMIZATION: Static functions moved completely outside the render cycle ---
const getConsumptionRate = (currentSpeed) => {
  if (currentSpeed > 90) return 13;
  if (currentSpeed >= 60) return 14; 
  return 12; 
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
            Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; 
};

// Global audio context reference to prevent memory leaks
let globalAudioCtx = null;
const playIgnitionTone = (freq, type, duration) => {
  try {
    if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = globalAudioCtx.createOscillator();
    const gain = globalAudioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, globalAudioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, globalAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, globalAudioCtx.currentTime + duration);
    osc.connect(gain); 
    gain.connect(globalAudioCtx.destination);
    osc.start(); 
    osc.stop(globalAudioCtx.currentTime + duration);
  } catch (e) {
    console.warn("Audio engine locked by browser policy.");
  }
};

const MAX_DIAL_SPEED = 160;

export default function App() {
  // --- SYSTEM STATES ---
  const [engineActive, setEngineActive] = useState(false);
  const [isPoweringUp, setIsPoweringUp] = useState(false);
  const [uiVisible, setUiVisible] = useState(false);
  
  // --- TELEMETRY STATES ---
  const [speed, setSpeed] = useState(0);
  const [sweepSpeed, setSweepSpeed] = useState(0); 
  const [gpsStatus, setGpsStatus] = useState('searching'); 
  const [avgSpeed, setAvgSpeed] = useState(0);
  const [ecoColor, setEcoColor] = useState('#3b82f6'); 

  // --- PERSISTENT STORAGE ---
  const [distance, setDistance] = useState(() => {
    const saved = parseFloat(localStorage.getItem('townace_distance'));
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

  // --- MODAL STATES ---
  const [isFuelModalOpen, setIsFuelModalOpen] = useState(false);
  const [tempFuel, setTempFuel] = useState(50);

  // --- HARDWARE REFS ---
  const watchIdRef = useRef(null);
  const staleIntervalRef = useRef(null);
  const lastUpdateTimeRef = useRef(Date.now());
  const lastCoordsRef = useRef(null);
  const lastSpeedRef = useRef(0); 
  const wakeLockRef = useRef(null);
  const speedQueueRef = useRef([]);

  // --- AUTO-SAVE EFFECTS ---
  useEffect(() => localStorage.setItem('townace_distance', distance.toString()), [distance]);
  useEffect(() => localStorage.setItem('townace_fuel', fuel.toString()), [fuel]);
  useEffect(() => localStorage.setItem('townace_theme', isDarkMode.toString()), [isDarkMode]);

  // --- CORE GPS ENGINE (Memoized to prevent unnecessary re-renders) ---
  const startGpsStream = useCallback(() => {
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
        
        speedQueueRef.current.push(0);
        if (speedQueueRef.current.length > 30) speedQueueRef.current.shift();
        const sum = speedQueueRef.current.reduce((a, b) => a + b, 0);
        setAvgSpeed(sum / speedQueueRef.current.length);

        setSpeed(prev => {
          if (prev < 2) setEcoColor('#3b82f6');
          return prev;
        });
      }
    }, 1000);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsStatus('ready');
        lastUpdateTimeRef.current = Date.now(); 
        
        const rawSpeed = pos.coords.speed;
        let kmh = rawSpeed && rawSpeed > 0.25 ? rawSpeed * 3.6 : 0;
        
        speedQueueRef.current.push(kmh);
        if (speedQueueRef.current.length > 30) speedQueueRef.current.shift(); 
        const sum = speedQueueRef.current.reduce((a, b) => a + b, 0);
        setAvgSpeed(sum / speedQueueRef.current.length);

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

        if (lastCoordsRef.current) {
          const d = calculateDistance(
            lastCoordsRef.current.latitude, lastCoordsRef.current.longitude, 
            pos.coords.latitude, pos.coords.longitude
          );
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
  }, [isDarkMode]);

  const stopGpsStream = useCallback(() => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    if (staleIntervalRef.current) clearInterval(staleIntervalRef.current);
    lastCoordsRef.current = null;
    lastSpeedRef.current = 0;
    speedQueueRef.current = [];
    setSpeed(0);
    setAvgSpeed(0);
    setEcoColor('#3b82f6');
  }, []);

  // --- MASTER IGNITION ---
  const toggleEngineState = useCallback(() => {
    if (!engineActive && !isPoweringUp) {
      setIsPoweringUp(true);
      playIgnitionTone(260, 'sawtooth', 0.4);
      if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(lock => { wakeLockRef.current = lock; }).catch(() => {});
      }
      
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
      if (wakeLockRef.current) { 
        wakeLockRef.current.release(); 
        wakeLockRef.current = null; 
      }
      stopGpsStream();
      setUiVisible(false);
      setTimeout(() => setEngineActive(false), 550);
    }
  }, [engineActive, isPoweringUp, startGpsStream, stopGpsStream]);

  const handleTripReset = useCallback(() => {
    setDistance(0);
    speedQueueRef.current = [];
    setAvgSpeed(0);
  }, []);

  // Strict cleanup on unmount
  useEffect(() => {
    return () => { 
      stopGpsStream(); 
      if (wakeLockRef.current) wakeLockRef.current.release(); 
    };
  }, [stopGpsStream]);

  // --- MEMOIZED UI CALCULATIONS ---
  const activeSpeed = isPoweringUp ? sweepSpeed : speed;
  const activeFuelBars = useMemo(() => Math.ceil((fuel / 50) * 6), [fuel]);
  const estimatedRange = useMemo(() => fuel * getConsumptionRate(speed), [fuel, speed]);

  const theme = useMemo(() => ({
    bg: isDarkMode ? '#000000' : '#f4f4f5', 
    text: isDarkMode ? '#ffffff' : '#18181b',
    muted: isDarkMode ? '#71717a' : '#52525b',
    cardBg: isDarkMode ? 'rgba(20,20,23,0.85)' : '#ffffff',
    cardBorder: isDarkMode ? 'rgba(63,63,70,0.5)' : 'rgba(212,212,216,0.9)',
    shadow: isDarkMode ? '0 15px 35px rgba(0,0,0,0.9)' : '0 10px 25px rgba(0,0,0,0.06)',
    btnBg: isDarkMode ? 'rgba(39,39,42,0.7)' : '#e4e4e7',
  }), [isDarkMode]);

  // --- RENDER ---
  return (
    <>
      {/* PORTRAIT WARNING */}
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: '#000000', zIndex: 9999,
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '20px', textAlign: 'center', color: '#ffffff'
      }} className="portrait-warning">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '16px' }}>
          <path d="M21 2v6h-6"></path>
          <path d="M21 13a9 9 0 1 1-3-7.7L21 8"></path>
        </svg>
        <h2 className="font-digital" style={{ fontSize: '22px', letterSpacing: '4px', margin: 0, color: '#3b82f6' }}>TURN DEVICE</h2>
        <p style={{ fontSize: '13px', color: '#a1a1aa', marginTop: '12px' }}>Please rotate your hardware horizontally.</p>
      </div>

      {/* DASHBOARD CANVAS */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'column', 
        justifyContent: 'space-between', boxSizing: 'border-box', zIndex: 1, backgroundColor: theme.bg,
        paddingTop: 'max(14px, env(safe-area-inset-top))',
        paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(24px, env(safe-area-inset-left))',
        paddingRight: 'max(24px, env(safe-area-inset-right))',
        transition: 'background-color 0.4s ease'
      }} className="main-dashboard-layout">
        
        {/* BACKGROUND GLOW */}
        <div style={{
          position: 'absolute', inset: 0, backgroundColor: engineActive ? ecoColor : 'transparent',
          opacity: isDarkMode ? 0.05 : 0.02, transition: 'background-color 1.5s ease-in-out', pointerEvents: 'none', zIndex: 0
        }} />

        {/* HEADER BLOCK */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', zIndex: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2vw' }}>
            <div>
              <h1 className="font-digital" style={{ margin: 0, fontSize: '1.6vw', letterSpacing: '3px', color: theme.muted, fontWeight: 'bold' }}>TOWNACE</h1>
              <p style={{ margin: '2px 0 0 0', fontSize: '1vw', color: theme.muted, letterSpacing: '1px', fontWeight: 'bold', fontFamily: 'system-ui, sans-serif' }}>
                トヨタ タウンエース DX
              </p>
            </div>
            
            <button 
              onClick={() => setIsDarkMode(!isDarkMode)}
              style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, color: theme.text, borderRadius: '10px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.3s' }}
            >
              {isDarkMode ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
              )}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1vw', background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '6px 16px', borderRadius: '12px', opacity: engineActive ? 1 : 0.2, transition: 'all 0.5s ease' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: '0.8vw', color: theme.muted, textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: '1px' }}>GPS</span>
              <span className="font-digital" style={{ fontSize: '1.2vw', fontWeight: 'bold', color: theme.text }}>
                {!engineActive ? 'OFF' : gpsStatus === 'ready' ? 'READY' : gpsStatus === 'searching' ? 'SEARCHING' : 'LOST'}
              </span>
            </div>
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', transition: 'all 0.4s ease', backgroundColor: !engineActive ? theme.muted : gpsStatus === 'ready' ? '#10b981' : gpsStatus === 'searching' ? '#f59e0b' : '#ef4444', boxShadow: engineActive && gpsStatus === 'ready' ? '0 0 10px #10b981' : 'none' }} />
          </div>
        </div>

        {/* METRICS GRID */}
        <div style={{ display: 'flex', flex: 1, width: '100%', alignItems: 'center', justifyContent: 'space-between', boxSizing: 'border-box', zIndex: 10 }}>
          
          <div className="fade-in-ui" style={{ width: '26%', display: 'flex', flexDirection: 'column', gap: '1.5vh', justifyContent: 'center', opacity: uiVisible ? 1 : 0, transform: uiVisible ? 'translateX(0)' : 'translateX(-40px)' }}>
            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '1.2vw 1.6vw', borderRadius: '16px', position: 'relative', boxShadow: theme.shadow }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#ef4444', borderRadius: '16px 0 0 16px' }} />
              <p style={{ margin: 0, fontSize: '1.1vw', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>AVG SPEED</p>
              <p style={{ margin: '2px 0 0 0', fontSize: '2.8vw', color: theme.text, fontWeight: 'bold' }}><span className="font-digital">{Math.round(avgSpeed)}</span><span style={{ fontSize: '1.1vw', color: theme.muted, marginLeft: '6px', fontWeight: 'bold' }}>KM/H</span></p>
            </div>

            <div onClick={() => { setTempFuel(Math.round(fuel)); setIsFuelModalOpen(true); }} style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '1.2vw 1.6vw', borderRadius: '16px', position: 'relative', boxShadow: theme.shadow, cursor: 'pointer' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#f59e0b', borderRadius: '16px 0 0 16px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '1.1vw', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>FUEL</p>
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: '1vh' }}>
                {[...Array(6)].map((_, i) => (
                  <div key={i} style={{ height: '8px', flex: 1, borderRadius: '2px', transition: 'background-color 0.5s ease', backgroundColor: i < activeFuelBars ? (activeFuelBars <= 1 ? '#ef4444' : '#f59e0b') : theme.btnBg }} />
                ))}
              </div>
            </div>
          </div>

          {/* MAIN SPEEDOMETER */}
          <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'absolute', width: '22vw', height: '14vw', borderRadius: '50%', backgroundColor: engineActive ? ecoColor : 'transparent', filter: 'blur(55px)', opacity: isDarkMode ? 0.45 : 0.7, transition: 'background-color 1.5s ease-in-out', zIndex: 0 }} />
            <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span className="font-digital" style={{ 
                fontSize: '13vw', fontWeight: '900', letterSpacing: '-0.4vw', margin: 0, padding: 0, lineHeight: 0.9, 
                color: !engineActive && !isPoweringUp ? theme.muted : theme.text, transition: 'color 0.4s ease',
                textShadow: engineActive && isDarkMode ? '0 0 30px rgba(255,255,255,0.1)' : 'none' 
              }}>
                {Math.round(activeSpeed)}
              </span>
              <span style={{ fontSize: '1.3vw', letterSpacing: '6px', color: engineActive ? theme.muted : theme.cardBorder, fontWeight: 'bold', marginTop: '4px' }}>KM/H</span>
            </div>
          </div>

          {/* RIGHT TELEMETRY */}
          <div className="fade-in-ui" style={{ width: '26%', display: 'flex', flexDirection: 'column', gap: '1.5vh', justifyContent: 'center', opacity: uiVisible ? 1 : 0, transform: uiVisible ? 'translateX(0)' : 'translateX(40px)' }}>
            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '1.2vw 1.6vw', borderRadius: '16px', position: 'relative', boxShadow: theme.shadow }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#3b82f6', borderRadius: '16px 0 0 16px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '1.1vw', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>TRIP</p>
                <button onClick={handleTripReset} style={{ background: theme.btnBg, border: 'none', color: theme.text, fontSize: '0.9vw', fontWeight: 'bold', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer' }}>RESET</button>
              </div>
              <p style={{ margin: '2px 0 0 0', fontSize: '2.8vw', color: theme.text, fontWeight: 'bold' }}><span className="font-digital">{distance.toFixed(1)}</span><span style={{ fontSize: '1.1vw', color: theme.muted, marginLeft: '6px', fontWeight: 'bold' }}>KM</span></p>
            </div>

            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, padding: '1.2vw 1.6vw', borderRadius: '16px', position: 'relative', boxShadow: theme.shadow }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#10b981', borderRadius: '16px 0 0 16px' }} />
              <p style={{ margin: 0, fontSize: '1.1vw', color: theme.muted, fontWeight: 'bold', letterSpacing: '2px' }}>EST RANGE</p>
              <p style={{ margin: '2px 0 0 0', fontSize: '2.8vw', color: theme.text, fontWeight: 'bold' }}><span className="font-digital">{Math.round(estimatedRange)}</span><span style={{ fontSize: '1.1vw', color: theme.muted, marginLeft: '6px', fontWeight: 'bold' }}>KM</span></p>
            </div>
          </div>
        </div>

        {/* IGNITION BUTTON */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-start', zIndex: 20 }}>
          <button onClick={toggleEngineState} disabled={isPoweringUp} style={{ 
            background: isPoweringUp ? theme.btnBg : engineActive ? 'rgba(239,68,68,0.1)' : theme.cardBg, 
            border: `2px solid ${engineActive ? '#ef4444' : theme.cardBorder}`, 
            color: isPoweringUp ? theme.muted : engineActive ? '#ef4444' : theme.text, 
            padding: '8px 20px', borderRadius: '30px', fontSize: '1vw', fontWeight: 'bold', letterSpacing: '2px', 
            cursor: isPoweringUp ? 'wait' : 'pointer', transition: 'all 0.4s ease', outline: 'none', 
            boxShadow: engineActive && isDarkMode ? '0 0 15px rgba(239,68,68,0.15)' : 'none' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isPoweringUp && <div className="animate-spin-fast" style={{ width: '10px', height: '10px', border: '2px solid #f59e0b', borderTopColor: 'transparent', borderRadius: '50%' }} />}
              <span className="font-digital">{isPoweringUp ? 'STARTING...' : engineActive ? 'ENG OFF' : 'ENG ON'}</span>
            </div>
          </button>
        </div>

        {/* FUEL MODAL */}
        {isFuelModalOpen && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: isDarkMode ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)', backdropFilter: 'blur(15px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            <div style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, borderRadius: '24px', padding: '32px', width: '280px', textAlign: 'center', boxShadow: theme.shadow }}>
              <h2 className="font-digital" style={{ margin: '0 0 20px 0', fontSize: '16px', letterSpacing: '2px', color: '#f59e0b' }}>ADJUST FUEL</h2>
              <div style={{ fontSize: '48px', color: theme.text, fontWeight: 'bold', marginBottom: '24px' }}><span className="font-digital">{tempFuel}</span><span style={{ fontSize: '18px', color: theme.muted }}>L</span></div>
              <input type="range" min="0" max="50" value={tempFuel} onChange={(e) => setTempFuel(Number(e.target.value))} style={{ width: '100%', marginBottom: '32px', accentColor: '#f59e0b' }} />
              <div style={{ display: 'flex', gap: '16px' }}>
                <button onClick={() => setIsFuelModalOpen(false)} style={{ flex: 1, padding: '12px', background: theme.btnBg, border: 'none', color: theme.text, borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>CANCEL</button>
                <button onClick={() => { setFuel(tempFuel); setIsFuelModalOpen(false); }} style={{ flex: 1, padding: '12px', background: '#f59e0b', border: 'none', color: '#000000', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>SAVE</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}