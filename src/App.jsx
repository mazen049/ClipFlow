import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Aperture, ArrowLeft, ArrowUpRight, Bell, Check, ChevronDown, Clapperboard,
  Clock3, CloudUpload, Film, FolderOpen, Gauge, HelpCircle, Home, Link2,
  MoreHorizontal, Play, Scissors, Settings2, Sparkles, Subtitles, Upload,
  WandSparkles, X, Youtube, Instagram, Music2, Trash2, Download, Sun, Moon,
  Monitor, ShieldCheck, Video, Search, ExternalLink
} from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'
const STORAGE_KEY = 'clipflow.projects.v1'
const SETTINGS_KEY = 'clipflow.settings.v1'
const nav = [
  { id: 'overview', label: 'Overview', icon: Home },
  { id: 'projects', label: 'My projects', icon: FolderOpen },
  { id: 'editor', label: 'Clip editor', icon: Scissors }
]
const platforms = [
  { name: 'YouTube Shorts', icon: Youtube, color: 'red' },
  { name: 'Instagram Reels', icon: Instagram, color: 'pink' },
  { name: 'TikTok', icon: Music2, color: 'white' }
]
const readStorage = (key, fallback) => {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}
const formatDate = value => new Date(value).toLocaleString()
const safeError = async response => {
  try {
    const data = await response.json()
    return data.detail || data.message || 'The request could not be completed.'
  } catch {
    return 'The server returned an unexpected response.'
  }
}

function App() {
  const [view, setView] = useState('overview')
  const [source, setSource] = useState('upload')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState(null)
  const [count, setCount] = useState(3)
  const [clipSeconds, setClipSeconds] = useState(30)
  const [apiStatus, setApiStatus] = useState('checking')
  const [projects, setProjects] = useState(() => readStorage(STORAGE_KEY, []))
  const [settings, setSettings] = useState(() => ({
    theme: 'dark',
    motion: true,
    ...(readStorage(SETTINGS_KEY, {}))
  }))
  const [selectedClip, setSelectedClip] = useState(null)
  const [search, setSearch] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetch(API_BASE + '/api/health')
      .then(response => {
        if (!response.ok) throw new Error('API unavailable')
        return response.json()
      })
      .then(data => { if (!cancelled) setApiStatus(data.ok ? 'online' : 'error') })
      .catch(() => { if (!cancelled) setApiStatus('offline') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.motion = settings.motion ? 'on' : 'off'
  }, [settings])

  const allClips = useMemo(() => projects.flatMap(project =>
    (project.clips || []).map(clip => ({ ...clip, projectId: project.id, projectName: project.name }))
  ), [projects])
  const totalClips = allClips.length
  const totalVideos = projects.length
  const savedMinutes = Math.round(allClips.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0) / 60)
  const filteredProjects = projects.filter(project =>
    project.name.toLowerCase().includes(search.toLowerCase())
  )
  const activeClip = selectedClip ? allClips.find(clip => clip.id === selectedClip) : null

  const go = next => {
    setView(next)
    setNotice('')
  }
  const chooseFile = selected => {
    if (!selected) return
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']
    const extensionOkay = /\.(mp4|mov|mkv|webm|m4v)$/i.test(selected.name)
    if (!allowed.includes(selected.type) && !extensionOkay) {
      setNotice('Unsupported file. Choose MP4, MOV, MKV or WEBM.')
      return
    }
    if (selected.size > 2 * 1024 * 1024 * 1024) {
      setNotice('The video is larger than the 2 GB upload limit.')
      return
    }
    setFile(selected)
    setNotice('Video selected and ready to process.')
  }

  const start = async () => {
    if (busy) return
    if (source === 'upload' && !file) {
      inputRef.current?.click()
      return
    }
    if (source === 'link') {
      try {
        const parsed = new URL(url)
        const allowed = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']
        if (parsed.protocol !== 'https:' || !allowed.includes(parsed.hostname.toLowerCase())) {
          setNotice('Use a public HTTPS YouTube or youtu.be link.')
          return
        }
      } catch {
        setNotice('Paste a valid YouTube link first.')
        return
      }
    }

    setBusy(true)
    setJob(null)
    setNotice('Connecting to the local ClipFlow service…')
    let projectId = null
    try {
      let response
      if (source === 'upload') {
        const data = new FormData()
        data.append('file', file)
        response = await fetch(API_BASE + '/api/jobs/upload?count=' + count + '&clip_seconds=' + clipSeconds, {
          method: 'POST',
          body: data
        })
      } else {
        response = await fetch(API_BASE + '/api/jobs/url?count=' + count + '&clip_seconds=' + clipSeconds, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        })
      }
      if (!response.ok) throw new Error(await safeError(response))
      let current = await response.json()
      projectId = current.id
      setJob(current)
      setNotice('Processing started. You can keep this tab open to follow progress.')

      while (current.status === 'queued' || current.status === 'processing') {
        await new Promise(resolve => setTimeout(resolve, 1800))
        const status = await fetch(API_BASE + '/api/jobs/' + encodeURIComponent(current.id))
        if (!status.ok) throw new Error(await safeError(status))
        current = await status.json()
        setJob(current)
      }
      if (current.status !== 'completed') throw new Error(current.message || 'Processing failed.')

      const completed = {
        id: projectId,
        name: file?.name || url,
        createdAt: new Date().toISOString(),
        status: 'completed',
        clips: (current.clips || []).map(clip => ({
          ...clip,
          id: String(clip.id),
          url: API_BASE + clip.url
        }))
      }
      setProjects(previous => [completed, ...previous.filter(item => item.id !== completed.id)])
      setSelectedClip(completed.clips[0]?.id || null)
      setNotice('Your clips are ready. Open My projects or Clip editor to view them.')
      setFile(null)
      setUrl('')
    } catch (error) {
      setNotice((error.message || 'Something went wrong') + ' Check that the local API is running.')
    } finally {
      setBusy(false)
    }
  }

  const deleteProject = id => {
    setProjects(previous => previous.filter(project => project.id !== id))
    if (selectedClip && allClips.some(clip => clip.id === selectedClip && clip.projectId === id)) {
      setSelectedClip(null)
    }
    setNotice('Project removed from this browser. The exported files on the API volume are not deleted.')
  }

  const pageTitle = nav.find(item => item.id === view)?.label || 'Settings'
  const stats = [
    { label: 'Videos processed', value: totalVideos, note: totalVideos ? 'Saved in this browser' : 'Your first one is waiting', icon: Film },
    { label: 'Clips created', value: totalClips, note: totalClips ? 'Ready to preview or download' : 'AI highlights will appear here', icon: Clapperboard },
    { label: 'Clip minutes', value: savedMinutes, note: 'Total exported clip duration', icon: Clock3 }
  ]

  const pageMotion = {
    initial: settings.motion ? { opacity: 0, y: 12 } : false,
    animate: { opacity: 1, y: 0 },
    exit: settings.motion ? { opacity: 0, y: -8 } : undefined,
    transition: { duration: settings.motion ? 0.22 : 0 }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Aperture size={21} /><span className="brand-mark-spark"><Sparkles size={9} /></span></div>
          <span>clipflow<span className="brand-dot">.</span></span>
        </div>
        <div className="workspace">
          <div className="workspace-avatar">C</div>
          <div><b>Creator workspace</b><small>Local workspace</small></div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(item => (
            <button key={item.id} className={'nav-item ' + (view === item.id ? 'active' : '')} onClick={() => go(item.id)}>
              <item.icon size={17} />{item.label}
              {item.id === 'projects' && <span className="nav-count">{projects.length}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-label tools-label">PREFERENCES</div>
        <button className={'nav-item ' + (view === 'settings' ? 'active' : '')} onClick={() => go('settings')}>
          <Settings2 size={17} />Settings
        </button>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon"><HelpCircle size={17} /></div>
            <b>Need a hand?</b>
            <p>Turn a long video into vertical clips with ClipFlow.</p>
            <button onClick={() => setNotice('1. Upload a video. 2. Choose clip count and duration. 3. Wait for processing. 4. Preview and download your clips.')}>Open quick guide <ArrowUpRight size={13} /></button>
          </div>
          <div className="profile">
            <div className="profile-avatar">M</div>
            <div><b>My workspace</b><small>Stored on this device</small></div>
            <MoreHorizontal size={18} />
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumb">Workspace <span>/</span> <b>{pageTitle}</b></div>
          <div className="top-actions">
            <span className="status-pill"><i className={apiStatus === 'online' ? 'api-online' : 'api-offline'} />{apiStatus === 'online' ? 'Processing API online' : apiStatus === 'checking' ? 'Checking local API…' : 'API offline'}</span>
            <button className="icon-button" aria-label="Notifications" onClick={() => setNotice(apiStatus === 'online' ? 'ClipFlow API is connected.' : 'Start Docker Compose to connect the local API.')}><Bell size={18} /></button>
            <div className="mini-avatar">M</div>
          </div>
        </header>

        <div className="content">
          <AnimatePresence mode="wait">
            {view === 'overview' && (
              <motion.div key="overview" {...pageMotion}>
                <section className="welcome">
                  <div>
                    <div className="eyebrow"><Sparkles size={13} /> YOUR CREATIVE WORKSPACE</div>
                    <h1>Make every moment <span>count.</span></h1>
                    <p>Turn long videos into short-form content people want to watch.</p>
                  </div>
                  <div className="welcome-art"><div className="orb orb-one" /><div className="orb orb-two" /><div className="art-ring"><Play size={25} fill="currentColor" /></div><span className="art-tag">CLIPFLOW STUDIO</span></div>
                </section>
                <section className="stats-grid">
                  {stats.map((stat, index) => (
                    <motion.div className="stat-card" key={stat.label} initial={settings.motion ? { opacity: 0, y: 14 } : false} animate={{ opacity: 1, y: 0 }} transition={{ delay: settings.motion ? index * .06 : 0 }}>
                      <div className="stat-top"><span>{stat.label}</span><stat.icon size={17} /></div>
                      <strong>{stat.value}</strong><small>{stat.note}</small>
                    </motion.div>
                  ))}
                </section>
                <section className="section-heading">
                  <div><div className="eyebrow">LET'S GET STARTED</div><h2>Create your first clips</h2><p>Drop in a video and set your workflow in motion.</p></div>
                  <span className="step-tag"><span>01</span> New project</span>
                </section>
                <motion.section className="create-card">
                  <div className="card-top"><div className="card-icon"><WandSparkles size={19} /></div><div><h3>Start with a video</h3><p>Upload a file or paste a public YouTube link.</p></div><span className="beta-tag">LOCAL AI</span></div>
                  <div className="source-tabs">
                    <button className={source === 'upload' ? 'selected' : ''} onClick={() => setSource('upload')}><Upload size={15} /> Upload video</button>
                    <button className={source === 'link' ? 'selected' : ''} onClick={() => setSource('link')}><Link2 size={15} /> Paste a link</button>
                  </div>
                  <div className="processing-options">
                    <label>Number of clips<select value={count} onChange={event => setCount(Number(event.target.value))}><option value={2}>2 clips</option><option value={3}>3 clips</option><option value={4}>4 clips</option><option value={5}>5 clips</option></select></label>
                    <label>Clip duration<select value={clipSeconds} onChange={event => setClipSeconds(Number(event.target.value))}><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={45}>45 seconds</option><option value={60}>60 seconds</option></select></label>
                  </div>
                  {source === 'upload' ? (
                    <div className={'dropzone ' + (file ? 'has-file' : '')} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFile(event.dataTransfer.files?.[0]) }} onClick={() => inputRef.current?.click()}>
                      <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.m4v" hidden onChange={event => chooseFile(event.target.files?.[0])} />
                      <div className="upload-icon">{file ? <Check size={22} /> : <CloudUpload size={23} />}</div>
                      <b>{file ? file.name : 'Drag & drop your video here'}</b>
                      <span>{file ? (file.size / 1024 / 1024).toFixed(1) + ' MB · Ready to configure' : 'or click to browse files'}</span>
                      <small>MP4, MOV, MKV, WEBM · Maximum 2 GB</small>
                    </div>
                  ) : (
                    <div className="link-field"><div className="link-icon"><Link2 size={18} /></div><input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://youtube.com/watch?v=..." /><button onClick={start}>Use link <ArrowUpRight size={14} /></button></div>
                  )}
                  <div className="card-footer"><div className="secure-note"><span className="secure-dot" /> Local processing · Files stay on your machine</div><button className="primary-button" onClick={start} disabled={busy}>{busy ? <><span className="spinner" /> Processing</> : <>Create clips <ArrowUpRight size={16} /></>}</button></div>
                  {notice && <motion.div className="notice" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></motion.div>}
                  {job && <div className="job-status"><div className="job-status-top"><b>{job.message}</b><span>{job.progress}%</span></div><div className="progress-track"><i style={{ width: job.progress + '%' }} /></div></div>}
                </motion.section>
                <section className="bottom-grid">
                  <div className="panel"><div className="panel-heading"><div><h3>Made for every platform</h3><p>Export vertical videos for your channels.</p></div><span className="tiny-spark"><Sparkles size={16} /></span></div><div className="platform-list">{platforms.map(platform => <div className="platform" key={platform.name}><div className={'platform-icon ' + platform.color}><platform.icon size={17} /></div><b>{platform.name}</b><span className="coming">Export ready</span></div>)}</div></div>
                  <div className="panel workflow-panel"><div className="panel-heading"><div><h3>Your workflow</h3><p>From long video to short-form story.</p></div><Gauge size={18} /></div><div className="workflow-steps">{[{ icon: Upload, title: 'Add your video', desc: 'Upload or paste a link' }, { icon: Sparkles, title: 'Find the highlights', desc: 'AI ranks transcript moments' }, { icon: Subtitles, title: 'Add captions', desc: 'Transcript captions are burned in' }, { icon: Download, title: 'Export your clips', desc: 'Download vertical MP4 files' }].map((step, index) => <div className="workflow-step" key={step.title}><div className="step-icon"><step.icon size={15} /></div><div><b>{step.title}</b><small>{step.desc}</small></div>{index === 0 ? <span className="step-current">START</span> : <span className="step-line" />}</div>)}</div></div>
                </section>
              </motion.div>
            )}

            {view === 'projects' && (
              <motion.div key="projects" {...pageMotion}>
                <section className="page-intro"><div><div className="eyebrow"><FolderOpen size={13} /> YOUR LIBRARY</div><h1>My <span>projects.</span></h1><p>Completed processing jobs saved in this browser.</p></div><button className="primary-button" onClick={() => go('overview')}><Upload size={15} /> New project</button></section>
                <div className="library-toolbar"><div className="search-box"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search projects..." /></div><span>{projects.length} project{projects.length === 1 ? '' : 's'}</span></div>
                {filteredProjects.length ? <div className="project-grid">{filteredProjects.map(project => <motion.article className="project-card" key={project.id} layout><div className="project-card-top"><div className="project-icon"><Video size={20} /></div><span className="project-status"><i /> Completed</span></div><h3 title={project.name}>{project.name}</h3><p>{formatDate(project.createdAt)}</p><div className="project-meta"><span>{project.clips.length} clips</span><span>{project.clips.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0)} sec total</span></div><div className="project-actions"><button onClick={() => { setSelectedClip(project.clips[0]?.id || null); go('editor') }}><Scissors size={14} /> Open editor</button><button className="danger-quiet" aria-label="Delete project" onClick={() => deleteProject(project.id)}><Trash2 size={14} /></button></div></motion.article>)}</div> : <div className="empty-state"><div className="empty-icon"><FolderOpen size={25} /></div><h3>{search ? 'No matching projects' : 'Your library is empty'}</h3><p>{search ? 'Try another search term.' : 'Create clips from a video and your finished projects will appear here.'}</p>{!search && <button className="primary-button" onClick={() => go('overview')}>Create your first project <ArrowUpRight size={15} /></button>}</div>}
              </motion.div>
            )}

            {view === 'editor' && (
              <motion.div key="editor" {...pageMotion}>
                <section className="page-intro"><div><div className="eyebrow"><Scissors size={13} /> CLIP WORKSPACE</div><h1>Clip <span>editor.</span></h1><p>Preview, inspect and download your generated vertical clips.</p></div><button className="secondary-button" onClick={() => go('projects')}><ArrowLeft size={15} /> All projects</button></section>
                {activeClip ? <div className="editor-layout"><div className="preview-panel"><div className="preview-top"><span><Play size={13} /> PREVIEW</span><span>9:16 · MP4</span></div><video key={activeClip.id} controls playsInline src={activeClip.url} /><div className="preview-caption"><b>{activeClip.title}</b><small>{activeClip.duration}s · {activeClip.method === 'evenly-spaced-fallback' ? 'Evenly spaced preview' : 'Transcript-ranked highlight'}</small></div><a className="download-link" href={activeClip.url} download><Download size={15} /> Download MP4 <ArrowUpRight size={14} /></a></div><div className="clip-list-panel"><div className="panel-heading"><div><h3>Generated clips</h3><p>{allClips.length} clips across your projects</p></div><Film size={18} /></div>{allClips.map(clip => <button key={clip.id} className={'clip-row ' + (clip.id === selectedClip ? 'chosen' : '')} onClick={() => setSelectedClip(clip.id)}><span className="clip-thumb"><Play size={14} /></span><span className="clip-row-copy"><b>{clip.title}</b><small>{clip.projectName} · {clip.duration}s</small></span><ArrowUpRight size={14} /></button>)}</div></div> : <div className="empty-state"><div className="empty-icon"><Scissors size={25} /></div><h3>No clips to edit yet</h3><p>Process a video first. Your generated clips will appear here for preview and download.</p><button className="primary-button" onClick={() => go('overview')}>Create clips <ArrowUpRight size={15} /></button></div>}
                <p className="editor-note"><ShieldCheck size={14} /> This first editor version previews and exports clips. Timeline trimming and caption styling are not implemented yet.</p>
              </motion.div>
            )}

            {view === 'settings' && (
              <motion.div key="settings" {...pageMotion}>
                <section className="page-intro"><div><div className="eyebrow"><Settings2 size={13} /> PREFERENCES</div><h1>Studio <span>settings.</span></h1><p>Control the appearance and local workspace data.</p></div></section>
                <div className="settings-layout">
                  <section className="settings-card"><div className="settings-heading"><div className="settings-symbol"><Monitor size={18} /></div><div><h3>Appearance</h3><p>Choose the look of your workspace.</p></div></div><div className="theme-options"><button className={settings.theme === 'dark' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setSettings(old => ({ ...old, theme: 'dark' }))}><Moon size={18} /><b>Midnight</b><small>Dark studio</small></button><button className={settings.theme === 'light' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setSettings(old => ({ ...old, theme: 'light' }))}><Sun size={18} /><b>Daylight</b><small>Light workspace</small></button></div></section>
                  <section className="settings-card"><div className="settings-heading"><div className="settings-symbol"><Sparkles size={18} /></div><div><h3>Motion effects</h3><p>Reduce interface animations.</p></div></div><label className="toggle-row"><span><b>Enable animations</b><small>Page transitions and hover effects</small></span><input type="checkbox" checked={settings.motion} onChange={event => setSettings(old => ({ ...old, motion: event.target.checked }))} /><i /></label></section>
                  <section className="settings-card security-card"><div className="settings-heading"><div className="settings-symbol"><ShieldCheck size={18} /></div><div><h3>Privacy & local data</h3><p>Projects are saved in this browser only. No account or cloud sync is configured.</p></div></div><div className="privacy-points"><span><Check size={14} /> Files are sent to your local API</span><span><Check size={14} /> Project list stays in browser storage</span><span><Check size={14} /> No passwords or payment details are stored</span></div><button className="danger-button" onClick={() => { if (window.confirm('Clear all project history saved in this browser? Exported video files will not be deleted.')) { setProjects([]); setSelectedClip(null); setNotice('Local project history cleared.') } }}><Trash2 size={15} /> Clear project history</button></section>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {notice && view !== 'overview' && <div className="notice global-notice"><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></div>}
          <footer><span>© 2026 ClipFlow</span><span>Local-first creator studio.</span><span className="footer-version">v0.2.0 · Studio</span></footer>
        </div>
      </main>
    </div>
  )
}

export default App
