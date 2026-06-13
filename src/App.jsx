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

  // --- HYPER-ACCURATE GPS ENGINE ---
  const startGpsStream = () => {
    if (!navigator.geolocation) {
      setGpsStatus('lost');
      return;
    }
    setGpsStatus('searching');
    lastUpdateTimeRef.current = Date.now();

    // The Decay Engine: Fixes iOS GPS sleep when stopped
    staleIntervalRef.current = setInterval(() => {
      if (Date.now() - lastUpdateTimeRef.current > 2000) {
        setSpeed((prev) => {
          if (prev > 0) {
            const decayed = prev * 0.4; // Drops speed to zero smoothly
            return decayed < 1 ? 0 : decayed;
          }
          return 0;
        });
        if (speed < 2) setEcoColor('#3b82f6'); // Return glow to Idle Blue
      }
    }, 500);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsStatus('ready');
        lastUpdateTimeRef.current = Date.now(); // Register fresh signal
        
        const rawSpeed = pos.coords.speed;
        
        // Stricter noise filter (approx 1 km/h cutoff)
        let kmh = rawSpeed && rawSpeed > 0.25 ? rawSpeed * 3.6 : 0;
        
        // WAGON-R GLOW LOGIC
        let acceleration = kmh - lastSpeedRef.current;
        if (kmh < 3) {
          setEcoColor('#3b82f6'); // Blue (Idle)
        } else if (acceleration > 1.2) {
          setEcoColor('#3b82f6'); // Blue (Accelerating)
        } else if (acceleration < -1.2) {
          setEcoColor('#ffffff'); // White (Braking/Coasting)
        } else {
          setEcoColor('#10b981'); // Green (Eco-Cruising)
        }
        
        lastSpeedRef.current = kmh;
        setSpeed(kmh);
        
        if (kmh > maxSpeed) setMaxSpeed(kmh);

        // Distance & Fuel tracking
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

  // --- SCALED UI CALCULATIONS FOR IPHONE 11 HEIGHT ---
  const activeSpeed = isPoweringUp ? sweepSpeed : speed;
  const radius = 110; // Scaled down to prevent clipping
  const circ = 2 * Math.PI * radius;
  const offset = circ - (Math.min(activeSpeed, MAX_DIAL_SPEED) / MAX_DIAL_SPEED) * circ;
  
  const activeFuelBars = Math.ceil((fuel / 50) * 6);
  const estimatedRange = fuel * getConsumptionRate(speed);

  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: '#09090b', zIndex: 9999,
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '20px', textAlign: 'center', color: '#ffffff'
      }} className="portrait-warning">
        <span style={{ fontSize: '40px', marginBottom: '16px' }}>🔄</span>
        <h2 className="font-digital" style={{ fontSize: '16px', letterSpacing: '2px', margin: 0, color: '#3b82f6' }}>ROTATE DEVICE</h2>
        <p style={{ fontSize: '12px', color: '#52525b', marginTop: '8px' }}>Please turn your iPhone horizontally.</p>
      </div>

      <div style={{
        position: 'absolute', inset: 0, width: '100vw', height: '100dvh', flexDirection: 'column', 
        justifyContent: 'space-between', boxSizing: 'border-box', zIndex: 1, backgroundColor: '#09090b',
        padding: '12px max(32px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left))'
      }} className="main-dashboard-layout">
        
        <div style={{
          position: 'absolute', inset: 0, backgroundColor: engineActive ? ecoColor : 'transparent',
          opacity: 0.08, transition: 'background-color 1.5s ease-in-out', pointerEvents: 'none', zIndex: 0
        }} />

        {/* --- TOP HEADER --- */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', zIndex: 20 }}>
          <div>
            <h1 className="font-digital" style={{ margin: 0, fontSize: '14px', letterSpacing: '4px', color: '#52525b', fontWeight: 'bold' }}>TOWNACE</h1>
            <p style={{ margin: '3px 0 0 0', fontSize: '10px', color: '#3f3f46', letterSpacing: '2px', fontWeight: 'bold' }}>DIGITAL DASH</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', background: 'rgba(24,24,27,0.4)', border: '1px solid rgba(63,63,70,0.3)', padding: '6px 16px', borderRadius: '12px', opacity: engineActive ? 1 : 0.15, transition: 'all 0.5s ease' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: '9px', color: '#71717a', textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: '1px' }}>GPS</span>
              <span className="font-digital" style={{ fontSize: '12px', fontWeight: 'bold', color: '#e4e4e7' }}>
                {!engineActive ? 'OFF' : gpsStatus === 'ready' ? 'READY' : gpsStatus === 'searching' ? 'SEARCHING' : 'LOST'}
              </span>
            </div>
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', transition: 'all 0.4s ease', backgroundColor: !engineActive ? '#27272a' : gpsStatus === 'ready' ? '#10b981' : gpsStatus === 'searching' ? '#f59e0b' : '#ef4444', boxShadow: engineActive && gpsStatus === 'ready' ? '0 0 10px #10b981' : 'none' }} />
          </div>
        </div>

        {/* --- MAIN MATRIX --- */}
        <div style={{ display: 'flex', flex: 1, width: '100%', alignItems: 'center', justifyContent: 'space-between', maxWidth: '1000px', margin: '0 auto', boxSizing: 'border-box', zIndex: 10 }}>
          
          {/* LEFT CARDS */}
          <div className="fade-in-ui" style={{ width: '26%', display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center', opacity: uiVisible ? 1 : 0, transform: uiVisible ? 'translateX(0)' : 'translateX(-40px)' }}>
            <div style={{ background: 'linear-gradient(135deg, rgba(24,24,27,0.6), rgba(9,9,11,0.9))', border: '1px solid rgba(63,63,70,0.3)', padding: '12px 16px', borderRadius: '16px', position: 'relative', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#ef4444', borderRadius: '16px 0 0 16px' }} />
              <p style={{ margin: 0, fontSize: '10px', color: '#71717a', fontWeight: 'bold', letterSpacing: '2px' }}>MAX SPEED</p>
              <p style={{ margin: '2px 0 0 0', fontSize: '24px', fontWeight: 'bold' }}><span className="font-digital">{Math.round(maxSpeed)}</span><span style={{ fontSize: '11px', color: '#52525b', marginLeft: '6px', fontWeight: 'bold' }}>KM/H</span></p>
            </div>

            <div onClick={() => { setTempFuel(Math.round(fuel)); setIsFuelModalOpen(true); }} style={{ background: 'linear-gradient(135deg, rgba(24,24,27,0.6), rgba(9,9,11,0.9))', border: '1px solid rgba(63,63,70,0.3)', padding: '12px 16px', borderRadius: '16px', position: 'relative', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', cursor: 'pointer' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#f59e0b', borderRadius: '16px 0 0 16px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '10px', color: '#71717a', fontWeight: 'bold', letterSpacing: '2px' }}>FUEL</p>
                <p style={{ margin: 0, fontSize: '11px', color: '#a1a1aa', fontWeight: 'bold' }}>{fuel.toFixed(1)}L</p>
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: '10px' }}>
                {[...Array(6)].map((_, i) => (
                  <div key={i} style={{ height: '6px', flex: 1, borderRadius: '2px', transition: 'background-color 0.5s ease', backgroundColor: i < activeFuelBars ? (activeFuelBars <= 1 ? '#ef4444' : '#f59e0b') : 'rgba(63,63,70,0.3)' }} />
                ))}
              </div>
            </div>
          </div>

          {/* CENTER: SCALED SPEEDOMETER */}
          <div style={{ position: 'relative', width: '260px', height: '260px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <div style={{ position: 'absolute', width: '180px', height: '180px', borderRadius: '50%', backgroundColor: engineActive ? ecoColor : 'transparent', filter: 'blur(45px)', opacity: 0.3, transition: 'background-color 1.5s ease-in-out', zIndex: 0 }} />
            <svg style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)', zIndex: 1 }}>
              <circle cx="130" cy="130" r={radius} stroke="rgba(24,24,27,0.7)" strokeWidth="14" fill="transparent" />
              <circle cx="130" cy="130" r={radius} stroke={activeSpeed > 110 ? '#ef4444' : activeSpeed > 70 ? '#f59e0b' : '#3b82f6'} strokeWidth="10" fill="transparent" strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: isPoweringUp ? 'stroke-dashoffset 0.5s ease-out' : 'stroke-dashoffset 0.18s ease-out' }} opacity={engineActive || isPoweringUp ? 1 : 0.04} />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', zIndex: 2 }}>
              <span className="font-digital" style={{ fontSize: '76px', fontWeight: '900', letterSpacing: '-4px', margin: 0, padding: 0, lineHeight: 1, color: !engineActive && !isPoweringUp ? '#18181b' : '#ffffff', transition: 'color 0.4s ease', textShadow: engineActive ? '0 0 20px rgba(255,255,255,0.2)' : 'none' }}>{Math.round(activeSpeed)}</span>
              <span style={{ fontSize: '11px', letterSpacing: '4px', color: engineActive ? '#52525b' : '#27272a', fontWeight: 'bold', marginTop: '4px' }}>KM/H</span>
            </div>
          </div>

          {/* RIGHT CARDS */}
          <div className="fade-in-ui" style={{ width: '26%', display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center', opacity: uiVisible ? 1 : 0, transform: uiVisible ? 'translateX(0)' : 'translateX(40px)' }}>
            <div style={{ background: 'linear-gradient(135deg, rgba(24,24,27,0.6), rgba(9,9,11,0.9))', border: '1px solid rgba(63,63,70,0.3)', padding: '12px 16px', borderRadius: '16px', position: 'relative', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#3b82f6', borderRadius: '16px 0 0 16px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '10px', color: '#71717a', fontWeight: 'bold', letterSpacing: '2px' }}>TRIP</p>
                <button onClick={handleTripReset} style={{ background: 'rgba(63,63,70,0.3)', border: '1px solid rgba(63,63,70,0.5)', color: '#a1a1aa', fontSize: '9px', fontWeight: 'bold', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer' }}>RESET</button>
              </div>
              <p style={{ margin: '2px 0 0 0', fontSize: '24px', fontWeight: 'bold' }}><span className="font-digital">{distance.toFixed(1)}</span><span style={{ fontSize: '11px', color: '#52525b', marginLeft: '6px', fontWeight: 'bold' }}>KM</span></p>
            </div>

            <div style={{ background: 'linear-gradient(135deg, rgba(24,24,27,0.6), rgba(9,9,11,0.9))', border: '1px solid rgba(63,63,70,0.3)', padding: '12px 16px', borderRadius: '16px', position: 'relative', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', backgroundColor: '#10b981', borderRadius: '16px 0 0 16px' }} />
              <p style={{ margin: 0, fontSize: '10px', color: '#71717a', fontWeight: 'bold', letterSpacing: '2px' }}>RANGE</p>
              <p style={{ margin: '2px 0 0 0', fontSize: '24px', fontWeight: 'bold' }}><span className="font-digital">{Math.round(estimatedRange)}</span><span style={{ fontSize: '11px', color: '#52525b', marginLeft: '6px', fontWeight: 'bold' }}>KM</span></p>
            </div>
          </div>

        </div>

        {/* --- SCALED BOTTOM CONTROL --- */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'center', zIndex: 20 }}>
          <button onClick={toggleEngineState} disabled={isPoweringUp} style={{ background: isPoweringUp ? 'rgba(39,39,42,0.2)' : engineActive ? 'rgba(239,68,68,0.08)' : 'rgba(24,24,27,0.85)', border: isPoweringUp ? '1px solid rgba(63,63,70,0.2)' : engineActive ? '1px solid #ef4444' : '1px solid #27272a', color: isPoweringUp ? '#71717a' : engineActive ? '#ef4444' : '#a1a1aa', padding: '12px 40px', borderRadius: '40px', fontSize: '12px', fontWeight: 'bold', letterSpacing: '4px', cursor: isPoweringUp ? 'wait' : 'pointer', transition: 'all 0.4s ease', outline: 'none', boxShadow: engineActive ? '0 0 20px rgba(239,68,68,0.25)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {isPoweringUp && <div className="animate-spin-fast" style={{ width: '12px', height: '12px', border: '2px solid #f59e0b', borderTopColor: 'transparent', borderRadius: '50%' }} />}
              <span className="font-digital">{isPoweringUp ? 'STARTING...' : engineActive ? 'ENGINE OFF' : 'ENGINE ON'}</span>
            </div>
          </button>
        </div>

        {/* --- FUEL OVERLAY MODAL --- */}
        {isFuelModalOpen && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: '24px', padding: '24px', width: '280px', textAlign: 'center', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }}>
              <h2 className="font-digital" style={{ margin: '0 0 16px 0', fontSize: '14px', letterSpacing: '2px', color: '#f59e0b' }}>ADJUST FUEL</h2>
              <div style={{ fontSize: '40px', fontWeight: 'bold', marginBottom: '20px' }}><span className="font-digital">{tempFuel}</span><span style={{ fontSize: '16px', color: '#71717a' }}>L</span></div>
              <input type="range" min="0" max="50" value={tempFuel} onChange={(e) => setTempFuel(Number(e.target.value))} style={{ width: '100%', marginBottom: '24px', accentColor: '#f59e0b' }} />
              <div style={{ display: 'flex', gap: '12px' }}>
                <button onClick={() => setIsFuelModalOpen(false)} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px solid #3f3f46', color: '#a1a1aa', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>CANCEL</button>
                <button onClick={() => { setFuel(tempFuel); setIsFuelModalOpen(false); }} style={{ flex: 1, padding: '10px', background: '#f59e0b', border: 'none', color: '#000', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>SAVE</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}