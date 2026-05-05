// Hero.jsx — display hero with mascot frame
function Hero() {
  return (
    <section style={heroStyles.wrap}>
      <div style={heroStyles.left}>
        <div style={heroStyles.eyebrow}>// SN · 0X1KEY-04A · 2026</div>
        <h1 style={heroStyles.headline}>
          One key.<br/>
          <span style={heroStyles.accentLine}>Every edge.</span>
        </h1>
        <p style={heroStyles.lede}>
          Drop-in auth, secrets, and routing for the world's fastest apps.
          Twelve milliseconds. Zero cold start. Built for the people who ship.
        </p>
        <div style={heroStyles.ctaRow}>
          <button style={heroStyles.primary}>Get a key <span style={{fontFamily:'JetBrains Mono'}}>→</span></button>
          <button style={heroStyles.secondary}>Read the docs</button>
        </div>
        <div style={heroStyles.signals}>
          <div style={heroStyles.sig}><b>p95 · 12ms</b><span>edge latency</span></div>
          <div style={heroStyles.sig}><b>14 regions</b><span>geo-routed</span></div>
          <div style={heroStyles.sig}><b>SOC 2</b><span>type II</span></div>
        </div>
      </div>
      <div style={heroStyles.right}>
        <div style={heroStyles.frame}>
          <div style={heroStyles.frameMeta}>
            <span>// JONY</span><span>0X1KEY-04A</span>
          </div>
          <img src="../../assets/mascot-jony.png" alt="JONY mascot" style={heroStyles.mascot}/>
          <div style={heroStyles.crosshair}>+</div>
          <div style={heroStyles.tickRow}>
            <span>FRAME 04</span><span style={{color:'#FF5A1F'}}>● REC</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const heroStyles = {
  wrap: {
    display:'grid', gridTemplateColumns:'1.2fr 1fr', gap:64,
    padding:'80px 32px 96px', borderBottom:'1.5px solid #0A0908',
    alignItems:'center',
  },
  left: { display:'flex', flexDirection:'column' },
  eyebrow: {
    fontFamily:'JetBrains Mono', fontSize:12, letterSpacing:'0.16em',
    textTransform:'uppercase', color:'#6B6259', marginBottom:24,
  },
  headline: {
    fontFamily:'Space Grotesk', fontWeight:700, fontSize:88, lineHeight:1.05,
    letterSpacing:'-0.04em', margin:0, color:'#0A0908',
  },
  accentLine: {
    background:'#FF5A1F', color:'#0A0908', padding:'0 12px', display:'inline-block',
    boxShadow:'4px 4px 0 0 #0A0908',
  },
  lede: {
    fontFamily:'Inter Tight', fontSize:20, lineHeight:1.45, color:'#2A2520',
    marginTop:48, maxWidth:520,
  },
  ctaRow: { display:'flex', gap:14, marginTop:36 },
  primary: {
    fontFamily:'Space Grotesk', fontWeight:600, fontSize:16, padding:'14px 22px',
    background:'#0A0908', color:'#FAF6EE', border:'2px solid #0A0908',
    boxShadow:'3px 3px 0 0 #FF5A1F', cursor:'pointer',
  },
  secondary: {
    fontFamily:'Space Grotesk', fontWeight:600, fontSize:16, padding:'14px 22px',
    background:'#FAF6EE', color:'#0A0908', border:'2px solid #0A0908', cursor:'pointer',
  },
  signals: { display:'flex', gap:36, marginTop:48, paddingTop:24, borderTop:'1.5px solid #0A0908', maxWidth:560 },
  sig: { display:'flex', flexDirection:'column', gap:4, fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.04em', textTransform:'uppercase', color:'#6B6259' },

  right: { display:'flex', justifyContent:'center' },
  frame: {
    width:420, background:'#F2EBDD', border:'2px solid #0A0908',
    boxShadow:'6px 6px 0 0 #0A0908', position:'relative', padding:14,
  },
  frameMeta: {
    display:'flex', justifyContent:'space-between',
    fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.08em',
    textTransform:'uppercase', color:'#0A0908', marginBottom:10,
  },
  mascot: { width:'100%', height:'auto', display:'block', background:'#FAF6EE', border:'1.5px solid #0A0908' },
  crosshair: {
    position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
    fontFamily:'JetBrains Mono', fontWeight:700, fontSize:18, color:'#FF5A1F',
    pointerEvents:'none',
  },
  tickRow: {
    display:'flex', justifyContent:'space-between', marginTop:10,
    fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.08em', textTransform:'uppercase',
  },
};

window.Hero = Hero;
