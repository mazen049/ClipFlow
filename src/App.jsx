import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Aperture, ArrowUpRight, Bell, Check, ChevronDown, Clapperboard, Clock3, CloudUpload, Film, FolderOpen, Gauge, HelpCircle, Home, Link2, Play, Scissors, Settings2, Sparkles, Subtitles, Upload, WandSparkles, X, Youtube, Instagram, Music2, Save, Server, RefreshCw } from 'lucide-react'

const nav = [{label:'Overview',icon:Home},{label:'My projects',icon:FolderOpen},{label:'Clip editor',icon:Scissors}]
const platforms = [{name:'YouTube Shorts',icon:Youtube,color:'red'},{name:'Instagram Reels',icon:Instagram,color:'pink'},{name:'TikTok',icon:Music2,color:'white'}]
const cleanUrl = value => value.trim().replace(/\/$/, '')
const readPrefs = () => {
  try { return JSON.parse(localStorage.getItem('clipflow-settings') || '{}') } catch { return {} }
}

function App(){
 const saved = readPrefs()
 const [page,setPage]=useState('Overview')
 const [source,setSource]=useState('upload')
 const [url,setUrl]=useState('')
 const [file,setFile]=useState(null)
 const [notice,setNotice]=useState('')
 const [busy,setBusy]=useState(false)
 const [job,setJob]=useState(null)
 const [projects,setProjects]=useState([])
 const [count,setCount]=useState(Number(saved.count)||3)
 const [clipSeconds,setClipSeconds]=useState(Number(saved.clipSeconds)||30)
 const [apiBase,setApiBase]=useState(saved.apiBase||'')
 const [apiStatus,setApiStatus]=useState('unknown')
 const [settingsOpen,setSettingsOpen]=useState(false)
 const inputRef=useRef(null)
 const API_BASE=cleanUrl(apiBase)

 useEffect(()=>{ if(API_BASE) checkApi(); else setApiStatus('not-configured') },[])
 const checkApi=async(base=API_BASE)=>{
   const target=cleanUrl(base)
   if(!target){setApiStatus('not-configured');return}
   setApiStatus('checking')
   try { const r=await fetch(target+'/api/health'); if(!r.ok) throw new Error('API response error'); const d=await r.json(); setApiStatus(d.ok?'online':'error'); return d }
   catch { setApiStatus('offline'); return null }
 }
 const saveSettings=()=>{
   localStorage.setItem('clipflow-settings',JSON.stringify({apiBase:cleanUrl(apiBase),count,clipSeconds}))
   setApiBase(cleanUrl(apiBase));setSettingsOpen(false);setNotice('Settings saved on this browser.');checkApi(cleanUrl(apiBase))
 }
 const chooseFile=f=>{if(!f)return;if(!f.type.startsWith('video/')){setNotice('Please choose a video file.');return}setFile(f);setNotice('Video selected and ready.')}
 const start=async()=>{
   if(busy)return
   if(!API_BASE){setSettingsOpen(true);setNotice('Add your hosted processing API address in Settings first.');return}
   if(source==='upload'&&!file){inputRef.current?.click();return}
   if(source==='link'&&!/^https:\/\//i.test(url)){setNotice('Paste a valid HTTPS video URL first.');return}
   setBusy(true);setJob(null);setNotice('Connecting to ClipFlow processing service…')
   try{
     let response
     if(source==='upload'){const data=new FormData();data.append('file',file);response=await fetch(API_BASE+`/api/jobs/upload?count=${count}&clip_seconds=${clipSeconds}`,{method:'POST',body:data})}
     else{response=await fetch(API_BASE+`/api/jobs/url?count=${count}&clip_seconds=${clipSeconds}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})}
     if(!response.ok)throw new Error((await response.json()).detail||'Could not start the job')
     let current=await response.json();setJob(current);setNotice('Processing started.')
     while(current.status==='queued'||current.status==='processing'){
       await new Promise(resolve=>setTimeout(resolve,2000))
       const status=await fetch(API_BASE+`/api/jobs/${current.id}`)
       if(!status.ok)throw new Error('Lost connection to the processing service')
       current=await status.json();setJob(current)
     }
     if(current.status==='completed'){
       setNotice('Your clips are ready.')
       const project={id:current.id,createdAt:new Date().toLocaleString(),clips:current.clips||[],status:'completed'}
       setProjects(old=>[project,...old])
     } else throw new Error(current.message||'Processing failed')
   }catch(error){setNotice(error.message+' — check the API address in Settings.')}
   finally{setBusy(false)}
 }
 const statusLabel=apiStatus==='online'?'Processing API online':apiStatus==='checking'?'Checking API…':apiStatus==='not-configured'?'API not configured':apiStatus==='error'?'API error':'API offline'
 const activeNav=(name)=>{setPage(name);setNotice('')}
 return <div className="app-shell">
  <aside className="sidebar">
   <div className="brand"><div className="brand-mark"><Aperture size={21}/><span className="brand-mark-spark"><Sparkles size={9}/></span></div><span>clipflow<span className="brand-dot">.</span></span></div>
   <div className="workspace"><div className="workspace-avatar">C</div><div><b>Creator workspace</b><small>Personal workspace</small></div><ChevronDown size={15}/></div>
   <div className="nav-label">WORKSPACE</div>
   <nav>{nav.map(n=><button className={'nav-item '+(page===n.label?'active':'')} key={n.label} onClick={()=>activeNav(n.label)}><n.icon size={17}/>{n.label}{n.label==='My projects'&&<span className="nav-count">{projects.length}</span>}</button>)}</nav>
   <div className="nav-label tools-label">PREFERENCES</div>
   <button className="nav-item" onClick={()=>setSettingsOpen(true)}><Settings2 size={17}/>Settings</button>
   <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><HelpCircle size={17}/></div><b>Need a hand?</b><p>Connect a hosted API in Settings to process videos from this website.</p><button onClick={()=>setSettingsOpen(true)}>Configure connection <ArrowUpRight size={13}/></button></div><div className="profile"><div className="profile-avatar">C</div><div><b>My workspace</b><small>GitHub Pages website</small></div></div></div>
  </aside>
  <main className="main">
   <header className="topbar"><div className="crumb">Workspace <span>/</span> <b>{page}</b></div><div className="top-actions"><button className="status-pill status-button" onClick={checkApi}><i className={apiStatus==='online'?'api-online':'api-offline'}/>{statusLabel}<RefreshCw size={12}/></button><button className="icon-button" aria-label="Notifications" onClick={()=>setNotice('You are all caught up.')}><Bell size={18}/></button><div className="mini-avatar">C</div></div></header>
   <div className="content">
    {page==='Overview'&&<>
     <motion.section className="welcome" initial={{opacity:0,y:14}} animate={{opacity:1,y:0}}><div><div className="eyebrow"><Sparkles size={13}/> YOUR CREATIVE WORKSPACE</div><h1>Make every moment <span>count.</span></h1><p>Turn long videos into short-form content people want to watch.</p></div><div className="welcome-art"><div className="orb orb-one"/><div className="orb orb-two"/><div className="art-ring"><Play size={25} fill="currentColor"/></div><span className="art-tag">CLIPFLOW STUDIO</span></div></motion.section>
     <section className="stats-grid">{[{label:'Videos processed',value:projects.length,note:'Projects in this session',icon:Film},{label:'Clips created',value:projects.reduce((n,p)=>n+p.clips.length,0),note:'Generated clips',icon:Clapperboard},{label:'Default duration',value:clipSeconds+'s',note:'Change in Settings',icon:Clock3}].map((s,i)=><motion.div className="stat-card" key={s.label}><div className="stat-top"><span>{s.label}</span><s.icon size={17}/></div><strong>{s.value}</strong><small>{s.note}</small></motion.div>)}</section>
     <section className="section-heading"><div><div className="eyebrow">LET'S GET STARTED</div><h2>Create your clips</h2><p>Upload a video or paste a public YouTube link.</p></div><span className="step-tag"><span>01</span> New project</span></section>
     <motion.section className="create-card"><div className="card-top"><div className="card-icon"><WandSparkles size={19}/></div><div><h3>Start with a video</h3><p>Choose a source and adjust your clip settings.</p></div><span className="beta-tag">STUDIO</span></div>
      <div className="source-tabs"><button className={source==='upload'?'selected':''} onClick={()=>setSource('upload')}><Upload size={15}/> Upload video</button><button className={source==='link'?'selected':''} onClick={()=>setSource('link')}><Link2 size={15}/> Paste a link</button></div>
      <div className="processing-options"><label>Number of clips<select value={count} onChange={e=>setCount(Number(e.target.value))}><option value={1}>1 clip</option><option value={2}>2 clips</option><option value={3}>3 clips</option><option value={4}>4 clips</option><option value={5}>5 clips</option><option value={6}>6 clips</option><option value={7}>7 clips</option><option value={8}>8 clips</option></select></label><label>Clip duration<select value={clipSeconds} onChange={e=>setClipSeconds(Number(e.target.value))}><option value={10}>10 seconds</option><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={45}>45 seconds</option><option value={60}>60 seconds</option><option value={90}>90 seconds</option></select></label></div>
      {source==='upload'?<div className={'dropzone '+(file?'has-file':'')} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFile(e.dataTransfer.files?.[0])}} onClick={()=>inputRef.current?.click()}><input ref={inputRef} type="file" accept="video/*" hidden onChange={e=>chooseFile(e.target.files?.[0])}/><div className="upload-icon">{file?<Check size={22}/>:<CloudUpload size={23}/>}</div><b>{file?file.name:'Drag & drop your video here'}</b><span>{file?(file.size/1024/1024).toFixed(1)+' MB · Ready to process':'or click to browse files'}</span><small>MP4, MOV, MKV, WEBM</small></div>:<div className="link-field"><div className="link-icon"><Link2 size={18}/></div><input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."/><button onClick={start}>Use link <ArrowUpRight size={14}/></button></div>}
      <div className="card-footer"><div className="secure-note"><span className="secure-dot"/>{API_BASE?'Connected API: '+API_BASE:'Set processing API in Settings'}</div><button className="primary-button" onClick={start} disabled={busy}>{busy?'Processing…':<>Create clips <ArrowUpRight size={16}/></>}</button></div>
      {notice&&<motion.div className="notice"><span>{notice}</span><button onClick={()=>setNotice('')}><X size={14}/></button></motion.div>}
      {job&&<div className="job-status"><div className="job-status-top"><b>{job.message}</b><span>{job.progress}%</span></div><div className="progress-track"><i style={{width:job.progress+'%'}}/></div>{job.status==='completed'&&<div className="clip-results">{job.clips.map(clip=><div className="clip-result" key={clip.id}><div><b>{clip.title}</b><small>{clip.duration}s · {clip.method==='evenly-spaced-fallback'?'Preview selection':'Transcript-ranked highlight'}</small></div><a href={API_BASE+clip.url} target="_blank" rel="noreferrer">Download <ArrowUpRight size={13}/></a></div>)}</div>}</div>}
     </motion.section>
     <section className="bottom-grid"><div className="panel"><div className="panel-heading"><div><h3>Made for every platform</h3><p>Vertical clips for your favorite destinations.</p></div><Sparkles size={16}/></div><div className="platform-list">{platforms.map(p=><div className="platform" key={p.name}><div className={'platform-icon '+p.color}><p.icon size={17}/></div><b>{p.name}</b><span className="coming">Export ready</span></div>)}</div></div><div className="panel"><div className="panel-heading"><div><h3>Your workflow</h3><p>From long video to short-form story.</p></div><Gauge size={18}/></div><div className="workflow-steps">{[{icon:Upload,title:'Add your video',desc:'Upload or paste a link'},{icon:Sparkles,title:'Find the highlights',desc:'Select engaging moments'},{icon:Subtitles,title:'Review captions',desc:'Captions from speech transcript'},{icon:ArrowUpRight,title:'Export clips',desc:'Download your MP4 files'}].map((s,i)=><div className="workflow-step" key={s.title}><div className="step-icon"><s.icon size={15}/></div><div><b>{s.title}</b><small>{s.desc}</small></div><span className="step-line"/></div>)}</div></div></section>
    </>}
    {page==='My projects'&&<section className="page-panel"><div className="section-heading"><div><div className="eyebrow">YOUR LIBRARY</div><h2>My projects</h2><p>Completed projects from this browser session.</p></div><button className="primary-button" onClick={()=>setPage('Overview')}>New project <ArrowUpRight size={15}/></button></div>{projects.length===0?<div className="empty-state"><FolderOpen size={34}/><h3>No projects yet</h3><p>Your completed video projects will appear here.</p><button className="primary-button" onClick={()=>setPage('Overview')}>Create your first clips</button></div>:projects.map(p=><div className="project-row" key={p.id}><div className="project-icon"><Film size={19}/></div><div className="project-info"><b>Project {p.id}</b><small>{p.createdAt} · {p.clips.length} clips</small></div><span className="project-status">Completed</span><button className="secondary-button" onClick={()=>{setJob({status:'completed',clips:p.clips,progress:100});setPage('Clip editor')}}>Open clips</button></div>)}</section>}
    {page==='Clip editor'&&<section className="page-panel"><div className="eyebrow">YOUR OUTPUTS</div><h2>Clip editor</h2><p className="page-subtitle">Preview and download the clips generated by ClipFlow.</p>{!job?.clips?.length?<div className="empty-state"><Scissors size={34}/><h3>No clips to edit yet</h3><p>Create a project first. Your generated clips will be listed here.</p><button className="primary-button" onClick={()=>setPage('Overview')}>Create clips</button></div>:<div className="editor-grid">{job.clips.map(c=><div className="editor-clip" key={c.id}><div className="editor-clip-preview"><Play size={24}/><span>{c.duration}s</span></div><b>{c.title}</b><small>Vertical MP4 · {c.method==='evenly-spaced-fallback'?'Preview':'AI transcript selection'}</small><a className="primary-button" href={API_BASE+c.url} target="_blank" rel="noreferrer">Download clip <ArrowUpRight size={14}/></a></div>)}</div>}</section>}
    <footer><span>© 2026 ClipFlow</span><span>Creator workspace</span><span className="footer-version">v0.2 · Pages edition</span></footer>
   </div>
  </main>
  {settingsOpen&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setSettingsOpen(false)}}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="settings-header"><div className="settings-heading-icon"><Settings2 size={19}/></div><div><h2 id="settings-title">ClipFlow settings</h2><p>Configure this website and your processing connection.</p></div><button className="icon-button" onClick={()=>setSettingsOpen(false)} aria-label="Close settings"><X size={19}/></button></div><label className="settings-label">Processing API address<input value={apiBase} onChange={e=>setApiBase(e.target.value)} placeholder="https://your-api-host.example.com"/></label><p className="settings-help"><Server size={13}/> Required for video processing. GitHub Pages hosts the website only; it cannot run the video engine itself.</p><div className="settings-row"><label>Default number of clips<select value={count} onChange={e=>setCount(Number(e.target.value))}>{[1,2,3,4,5,6,7,8].map(n=><option value={n} key={n}>{n} clips</option>)}</select></label><label>Default clip duration<select value={clipSeconds} onChange={e=>setClipSeconds(Number(e.target.value))}>{[10,15,30,45,60,90].map(n=><option value={n} key={n}>{n} seconds</option>)}</select></label></div><div className="settings-note"><b>Not available in the current processing engine</b><span>Automatic face tracking, smart reframing, and advanced montage controls are not implemented yet. These settings are not shown as working features.</span></div><div className="settings-actions"><button className="secondary-button" onClick={checkApi}>Test connection</button><button className="primary-button" onClick={saveSettings}><Save size={15}/> Save settings</button></div><div className="settings-connection">Connection status: <b>{statusLabel}</b></div></section></div>}
 </div>
}
export default App
