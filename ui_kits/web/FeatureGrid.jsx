// FeatureGrid.jsx — three-up feature cards
function FeatureGrid() {
  const items = [
    { sn:'01', title:'Edge keys', desc:'Issue, rotate, revoke. From any region, in milliseconds.', tag:'AUTH' },
    { sn:'02', title:'Hot path routing', desc:'Geo-pinned. Zero cold start. P95 under 12ms.', tag:'PERF', accent:true },
    { sn:'03', title:'Audit-ready', desc:'Every key call logged, queryable, exportable.', tag:'COMPLIANCE' },
  ];
  return (
    <section style={fgStyles.wrap}>
      <div style={fgStyles.head}>
        <div style={fgStyles.eyebrow}>// 02 — WHAT'S INSIDE</div>
        <h2 style={fgStyles.h2}>Three primitives. One key.</h2>
      </div>
      <div style={fgStyles.grid}>
        {items.map(it => (
          <div key={it.sn} style={{...fgStyles.card, boxShadow: it.accent ? '4px 4px 0 0 #FF5A1F' : '4px 4px 0 0 #0A0908'}}>
            <div style={fgStyles.cardTop}>
              <span style={fgStyles.sn}>SN-{it.sn}</span>
              <span style={{...fgStyles.tag, ...(it.accent ? {background:'#FF5A1F'} : {})}}>{it.tag}</span>
            </div>
            <div style={fgStyles.cardTitle}>{it.title}</div>
            <div style={fgStyles.cardDesc}>{it.desc}</div>
            <div style={fgStyles.cardFoot}>
              <a href="#" style={fgStyles.lk}>Learn more <span style={{fontFamily:'JetBrains Mono'}}>↗</span></a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const fgStyles = {
  wrap: { padding:'96px 32px', borderBottom:'1.5px solid #0A0908' },
  head: { marginBottom:48 },
  eyebrow: { fontFamily:'JetBrains Mono', fontSize:12, letterSpacing:'0.16em', textTransform:'uppercase', color:'#6B6259', marginBottom:14 },
  h2: { fontFamily:'Space Grotesk', fontWeight:700, fontSize:56, letterSpacing:'-0.03em', margin:0, color:'#0A0908', lineHeight:1.05 },
  grid: { display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:24 },
  card: { background:'#FAF6EE', border:'2px solid #0A0908', padding:24, display:'flex', flexDirection:'column', gap:12, minHeight:240 },
  cardTop: { display:'flex', justifyContent:'space-between', alignItems:'center' },
  sn: { fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.08em', textTransform:'uppercase', color:'#6B6259' },
  tag: { fontFamily:'JetBrains Mono', fontSize:10, letterSpacing:'0.12em', textTransform:'uppercase', background:'#0A0908', color:'#FAF6EE', padding:'3px 7px' },
  cardTitle: { fontFamily:'Space Grotesk', fontWeight:600, fontSize:28, letterSpacing:'-0.02em', color:'#0A0908', marginTop:8 },
  cardDesc: { fontFamily:'Inter Tight', fontSize:15, lineHeight:1.5, color:'#2A2520', flex:1 },
  cardFoot: { borderTop:'1px solid #E6DCC7', paddingTop:14, marginTop:8 },
  lk: { fontFamily:'Space Grotesk', fontWeight:600, fontSize:14, color:'#0A0908', textDecoration:'none', borderBottom:'2px solid #FF5A1F', paddingBottom:1 },
};

window.FeatureGrid = FeatureGrid;
