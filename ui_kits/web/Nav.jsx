// Nav.jsx — top navigation bar
function Nav() {
  return (
    <nav style={navStyles.bar}>
      <a href="#" style={navStyles.lockup}>
        <span style={navStyles.glyph}>o<span style={{color:'#FF5A1F'}}>1</span></span>
        <span style={navStyles.word}>o<span style={{color:'#FF5A1F'}}>1</span>key<span style={navStyles.dot}/></span>
      </a>
      <div style={navStyles.links}>
        <a href="#" style={navStyles.link}>Product</a>
        <a href="#" style={navStyles.link}>Pricing</a>
        <a href="#" style={navStyles.link}>Docs</a>
        <a href="#" style={navStyles.link}>Changelog</a>
      </div>
      <div style={navStyles.right}>
        <a href="#" style={navStyles.link}>Log in</a>
        <button style={navStyles.cta}>Get a key <span style={{fontFamily:'JetBrains Mono'}}>→</span></button>
      </div>
    </nav>
  );
}

const navStyles = {
  bar: {
    display:'flex', alignItems:'center', justifyContent:'space-between',
    padding:'18px 32px', borderBottom:'1.5px solid #0A0908',
    background:'#FAF6EE', position:'sticky', top:0, zIndex:10,
  },
  lockup: { display:'flex', alignItems:'center', gap:10, textDecoration:'none', color:'#0A0908' },
  glyph: {
    width:36, height:36, background:'#0A0908', color:'#FAF6EE',
    display:'flex', alignItems:'center', justifyContent:'center',
    fontFamily:'Space Grotesk', fontWeight:700, fontSize:20, letterSpacing:'-0.04em',
  },
  word: { fontFamily:'Space Grotesk', fontWeight:700, fontSize:22, letterSpacing:'-0.04em', position:'relative' },
  dot: { display:'inline-block', width:6, height:6, background:'#FF5A1F', marginLeft:2 },
  links: { display:'flex', gap:28 },
  link: { fontFamily:'Inter Tight', fontSize:14, color:'#0A0908', textDecoration:'none', fontWeight:500, whiteSpace:'nowrap' },
  right: { display:'flex', alignItems:'center', gap:18 },
  cta: {
    fontFamily:'Space Grotesk', fontWeight:600, fontSize:14, padding:'10px 16px',
    background:'#0A0908', color:'#FAF6EE', border:'2px solid #0A0908',
    boxShadow:'3px 3px 0 0 #FF5A1F', cursor:'pointer', display:'inline-flex', alignItems:'center', gap:8,
  },
};

window.Nav = Nav;
