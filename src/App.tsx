import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, MemoryRouter, NavLink, Route, Routes, useLocation, useNavigate, Link } from 'react-router-dom';
import { ConfirmLayer } from './components/Confirm';
import { IS_ARTIFACT } from './lib/target';

// The preview build keeps navigation in memory: its host does not pass hash paths through.
const Router = IS_ARTIFACT ? MemoryRouter : HashRouter;
import { Icon } from './components/Icon';
import { ToastLayer, toast } from './components/Toasts';
import { Logo } from './components/Logo';
import { setPrefs, usePrefs } from './store/prefs';
import { onStorageError, storageBackend } from './store/persist';
import Dashboard from './pages/Dashboard';

const Library = lazy(() => import('./pages/Library'));
const Workspace = lazy(() => import('./pages/Workspace'));
const Results = lazy(() => import('./pages/Results'));
const Compare = lazy(() => import('./pages/Compare'));
const History = lazy(() => import('./pages/History'));
const Builder = lazy(() => import('./pages/Builder'));
const Discoveries = lazy(() => import('./pages/Discoveries'));
const Settings = lazy(() => import('./pages/Settings'));
const Shared = lazy(() => import('./pages/Shared'));
const Planned = lazy(() => import('./pages/Planned'));
const About = lazy(() => import('./pages/About'));

const NAV = [
  { to: '/', label: 'Lab', icon: 'home', end: true },
  { to: '/library', label: 'Library', icon: 'grid' },
  { to: '/builder', label: 'Create', icon: 'plus' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/discoveries', label: 'Discoveries', icon: 'trophy' },
];

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function TopBar() {
  const prefs = usePrefs();
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="WHAT IF LAB home">
        <Logo size={28} />
        <span className="brand-name">
          WHAT IF <span>LAB</span>
        </span>
      </Link>
      <nav className="topnav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="topbar-tools">
        <button className="btn-icon" onClick={() => navigate('/library?focus=1')} aria-label="Search experiments" title="Search experiments">
          <Icon name="search" />
        </button>
        <button
          className={`btn-icon ${prefs.sound ? 'on' : ''}`}
          onClick={() => setPrefs({ sound: !prefs.sound })}
          aria-pressed={prefs.sound}
          aria-label={prefs.sound ? 'Mute sounds' : 'Enable sounds'}
          title={prefs.sound ? 'Sound on' : 'Sound off'}
        >
          <Icon name={prefs.sound ? 'sound' : 'mute'} />
        </button>
        <NavLink to="/settings" className="btn-icon" aria-label="Settings" title="Settings">
          <Icon name="settings" />
        </NavLink>
      </div>
    </header>
  );
}

function BottomNav() {
  return (
    <nav className="bottomnav" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')}>
          <Icon name={n.icon} size={20} />
          <span>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function StorageWarnings() {
  useEffect(() => {
    if (storageBackend() === 'memory') toast('Browser storage is unavailable: saved experiments will last only until this tab closes.', 'warning');
    return onStorageError((m) => toast(m, 'error'));
  }, []);
  return null;
}

export function App() {
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ScrollToTop />
      <StorageWarnings />
      <div className="app">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <TopBar />
        <main id="main" className="main">
          <Suspense
            fallback={
              <div className="page narrow loading-block" role="status">
                <span className="spinner" /> Loading…
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/library" element={<Library />} />
              <Route path="/lab/:experimentId" element={<Workspace />} />
              <Route path="/lab" element={<Workspace />} />
              <Route path="/planned/:id" element={<Planned />} />
              <Route path="/results/:id" element={<Results />} />
              <Route path="/compare" element={<Compare />} />
              <Route path="/history" element={<History />} />
              <Route path="/builder" element={<Builder />} />
              <Route path="/discoveries" element={<Discoveries />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/shared/:payload" element={<Shared />} />
              <Route path="/about" element={<About />} />
              <Route
                path="*"
                element={
                  <div className="page narrow empty-state">
                    <h1>Page not found</h1>
                    <Link to="/" className="btn primary">
                      Back to the lab
                    </Link>
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </main>
        <footer className="footer">
          <span>WHAT IF LAB — reality is the starting point.</span>
          <Link to="/about">Models, data &amp; methods</Link>
        </footer>
        <BottomNav />
        <ToastLayer />
        <ConfirmLayer />
      </div>
    </Router>
  );
}
