// Footer.jsx — minimal mono footer
function Footer() {
  const cols = [
    { h:'PRODUCT', items:['Edge keys','Routing','Audit','Changelog'] },
    { h:'DEVELOPERS', items:['Docs','Quickstart','API reference','Status'] },
    { h:'COMPANY', items:['About','Customers','Careers','Contact'] },
  ];
  return (
    <footer style={ftStyles.wrap}>
      <div style={ftStyles.top}>
        <div style={ftStyles.brand}>
          <div style={ftStyles.lockup}>
            <span style={ftStyles.glyph}>o<span style={{color:'#FF5A1F'}}>1</span></span>
            <span style={ftStyles.word}>o<span style={{color:'#FF5A1F'}}>1</span>key<span style={ftStyles.dot}/></span>
          </div>
          <div style={ftStyles.tag}>One key. Every edge.</div>
        </div>
        {cols.map(c => (
          <div key={c.h} style={ftStyles.col}>
            <div style={ftStyles.colH}>{c.h}</div>
            {c.items.map(i => <a key={i} href="#" style={ftStyles.colA}>{i}</a>)}
          </div>
        ))}
      </div>
      <div style={ftStyles.bottom}>
        <span>© 2026 o1key, inc.</span>
        <span>SN · 0X1KEY-04A · BUILD 2026.04.30</span>
        <span>Made on the edge.</span>
      </div>
    </footer>
  );
}

const ftStyles = {
  wrap: { background:'#0A0908', color:'#FAF6EE', padding:'64px 32px 24px' },
  top: { display:'grid', gridTemplateColumns:'1.5fr 1fr 1fr 1fr', gap:32, paddingBottom:48, borderBottom:'1px solid #2A2520' },
  brand: { display:'flex', flexDirection:'column', gap:14 },
  lockup: { display:'flex', alignItems:'center', gap:10 },
  glyph: { width:36, height:36, background:'#FAF6EE', color:'#0A0908', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Space Grotesk', fontWeight:700, fontSize:20, letterSpacing:'-0.04em' },
  word: { fontFamily:'Space Grotesk', fontWeight:700, fontSize:22, letterSpacing:'-0.04em' },
  dot: { display:'inline-block', width:6, height:6, background:'#FF5A1F', marginLeft:2 },
  tag: { fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.08em', textTransform:'uppercase', color:'#B8AFA3' },
  col: { display:'flex', flexDirection:'column', gap:10 },
  colH: { fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.16em', textTransform:'uppercase', color:'#FF5A1F', marginBottom:6 },
  colA: { fontFamily:'Inter Tight', fontSize:14, color:'#FAF6EE', textDecoration:'none' },
  bottom: { display:'flex', justifyContent:'space-between', paddingTop:24, fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.08em', textTransform:'uppercase', color:'#6B6259' },
};

window.Footer = Footer;
