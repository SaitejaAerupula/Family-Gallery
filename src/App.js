import './App.css';
import { useEffect, useState } from 'react';

const API_BASE =
  process.env.REACT_APP_API_BASE ||
  (typeof window !== 'undefined' ? `${window.location.origin}/api` : 'http://localhost:5000/api');

async function apiFetch(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  const controller = new AbortController();
  const timeoutMs = 30000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === 'AbortError') {
      throw new Error('Server is taking too long to respond. If hosted on Render, wait 30-60 seconds for cold start and try again.');
    }
    throw new Error(
      'Cannot connect to API server. Run app from project root and make sure backend is running on http://localhost:5000.'
    );
  }
  clearTimeout(timeoutId);

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const parts = [data.error, data.details].filter(Boolean);
    const err = new Error(parts.join(' ') || 'Request failed.');
    err.status = response.status;
    throw err;
  }
  return data;
}

function App() {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loggedInEmail, setLoggedInEmail] = useState('');

  const [folders, setFolders] = useState([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [activeType, setActiveType] = useState('image');
  const [folderFilter, setFolderFilter] = useState('');
  const [mediaItems, setMediaItems] = useState([]);
  const [mediaUrls, setMediaUrls] = useState({});
  const [selectedFiles, setSelectedFiles] = useState([]);

  const mediaLabels = {
    image: 'Images',
    video: 'Videos',
    audio: 'Songs',
  };
  const acceptByType = {
    image: 'image/*',
    video: 'video/*',
    audio: 'audio/*',
  };

  useEffect(() => {
    return () => {
      Object.values(mediaUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [mediaUrls]);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch('/auth/session');
        setLoggedInEmail(data.email || '');
        setIsAuthenticated(Boolean(data.email));
      } catch {
        setIsAuthenticated(false);
      }
    })();
  }, []);

  async function requestOtp(event) {
    event.preventDefault();
    setError('');
    setStatus('');
    setLoading(true);

    try {
      const data = await apiFetch('/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setStatus(data.message || 'OTP sent. Check your email inbox.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(event) {
    event.preventDefault();
    setError('');
    setStatus('');
    setLoading(true);

    try {
      const data = await apiFetch('/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });

      setLoggedInEmail(data.email);
      setIsAuthenticated(true);
      setOtp('');
      setStatus('Login successful.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchFolders() {
    if (!isAuthenticated) {
      return;
    }

    const data = await apiFetch('/folders');
    setFolders(data.folders || []);
  }

  async function fetchMedia(type = activeType, selectedFolder = folderFilter) {
    if (!isAuthenticated) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const query = new URLSearchParams({ type });
      if (selectedFolder) {
        query.set('folderId', selectedFolder);
      }

      const data = await apiFetch(`/media?${query.toString()}`);
      const gallery = data.media || [];

      const nextUrls = {};
      await Promise.all(
        gallery.map(async (item) => {
          const response = await fetch(`${API_BASE}/media/${item.id}`, {
            credentials: 'include',
          });
          if (!response.ok) {
            return;
          }
          const blob = await response.blob();
          nextUrls[item.id] = URL.createObjectURL(blob);
        })
      );

      Object.values(mediaUrls).forEach((url) => URL.revokeObjectURL(url));
      setMediaUrls(nextUrls);
      setMediaItems(gallery);
    } catch (err) {
      if (err.status === 401) {
        setIsAuthenticated(false);
        setLoggedInEmail('');
        setFolders([]);
        setMediaItems([]);
        setMediaUrls({});
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isAuthenticated) {
      (async () => {
        try {
          await fetchFolders();
          await fetchMedia(activeType, folderFilter);
        } catch (err) {
          setError(err.message);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchMedia(activeType, folderFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, folderFilter, isAuthenticated]);

  async function createFolder(event) {
    event.preventDefault();
    if (!newFolderName.trim()) {
      setError('Please enter a folder name.');
      return;
    }

    setLoading(true);
    setError('');
    setStatus('');

    try {
      const data = await apiFetch(
        '/folders',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newFolderName }),
        }
      );

      setStatus(data.message || 'Folder created.');
      setNewFolderName('');
      await fetchFolders();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function uploadMedia(event) {
    event.preventDefault();
    if (!selectedFiles.length) {
      setError(`Please select one or more ${mediaLabels[activeType].toLowerCase()} files first.`);
      return;
    }

    setLoading(true);
    setError('');
    setStatus('');

    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      formData.append('mediaType', activeType);
      if (folderFilter) {
        formData.append('folderId', folderFilter);
      }

      const data = await apiFetch(
        '/media/upload',
        {
          method: 'POST',
          body: formData,
        }
      );

      setStatus(data.message || 'Upload successful.');
      setSelectedFiles([]);
      await fetchMedia(activeType, folderFilter);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    Object.values(mediaUrls).forEach((url) => URL.revokeObjectURL(url));

    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // Even if network fails, clear local state for safety.
    }

    setIsAuthenticated(false);
    setLoggedInEmail('');
    setFolders([]);
    setMediaItems([]);
    setMediaUrls({});
    setFolderFilter('');
    setActiveType('image');
    setStatus('You have been logged out.');
    setError('');
  }

  return (
    <div className="app-shell">
      <main className="panel">
        <section className="hero">
          <div>
            <p className="eyebrow">Encrypted Personal Cloud</p>
            <h1>Welcome To Tejas Space</h1>
            <p className="tagline">
              Store your private photos, videos, and songs securely. Create folders, organize memories, and
              access them across mobile and desktop whenever you need your space.
            </p>
          </div>
          <div className="hero-grid">
            <article className="hero-card">
              <h3>Secure Vault</h3>
              <p>Every file is encrypted at rest using server-side protection.</p>
            </article>
            <article className="hero-card">
              <h3>Smart Folders</h3>
              <p>Create your own folders and keep each moment cleanly organized.</p>
            </article>
            <article className="hero-card">
              <h3>Media Lounge</h3>
              <p>Preview images, watch videos, and play songs directly in your private dashboard.</p>
            </article>
          </div>
        </section>

        {!isAuthenticated ? (
          <section className="auth-grid">
            <form className="card" onSubmit={requestOtp}>
              <h2>Step 1: Get OTP</h2>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
              <button disabled={loading} type="submit">
                {loading ? 'Sending...' : 'Send Real OTP Mail'}
              </button>
            </form>

            <form className="card" onSubmit={verifyOtp}>
              <h2>Step 2: Verify Login</h2>
              <label htmlFor="otp">6-Digit OTP</label>
              <input
                id="otp"
                type="text"
                maxLength={6}
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                required
              />
              <button disabled={loading || !email} type="submit">
                {loading ? 'Verifying...' : 'Verify And Login'}
              </button>
            </form>
          </section>
        ) : (
          <section className="vault">
            <div className="vault-header">
              <div>
                <h2>Welcome, {loggedInEmail}</h2>
                <p>Your files are encrypted at rest and shown only after secure login.</p>
              </div>
              <div className="actions">
                <button onClick={() => fetchMedia(activeType, folderFilter)} disabled={loading} type="button">
                  Refresh
                </button>
                <button className="outline" onClick={logout} type="button">
                  Logout
                </button>
              </div>
            </div>

            <section className="card folder-zone">
              <div>
                <h3>Create Folder</h3>
                <p>Build spaces for travel, family, work, music, or private notes.</p>
              </div>
              <form className="folder-form" onSubmit={createFolder}>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  placeholder="e.g. 2026 Summer Trip"
                />
                <button disabled={loading} type="submit">
                  Add Folder
                </button>
              </form>
              <label htmlFor="folderFilter">Filter By Folder</label>
              <select
                id="folderFilter"
                value={folderFilter}
                onChange={(event) => setFolderFilter(event.target.value)}
              >
                <option value="">All Folders</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </section>

            <section className="card tabs-card">
              <div className="tabs">
                {Object.keys(mediaLabels).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`tab-btn ${activeType === type ? 'active' : ''}`}
                    onClick={() => {
                      setActiveType(type);
                      setSelectedFiles([]);
                    }}
                  >
                    {mediaLabels[type]}
                  </button>
                ))}
              </div>
            </section>

            <form className="card upload-card" onSubmit={uploadMedia}>
              <h3>Upload {mediaLabels[activeType]}</h3>
              <input
                type="file"
                accept={acceptByType[activeType]}
                multiple
                onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))}
              />
              <button disabled={loading || !selectedFiles.length} type="submit">
                {loading ? 'Uploading...' : `Upload ${selectedFiles.length || ''} ${mediaLabels[activeType]}`}
              </button>
            </form>

            <div className="gallery">
              {mediaItems.length === 0 ? (
                <p className="empty">
                  No {mediaLabels[activeType].toLowerCase()} yet. Upload your first secure file.
                </p>
              ) : (
                mediaItems.map((item) => (
                  <article className="photo" key={item.id}>
                    {activeType === 'image' && mediaUrls[item.id] && (
                      <img src={mediaUrls[item.id]} alt={item.originalName} loading="lazy" />
                    )}

                    {activeType === 'video' && mediaUrls[item.id] && (
                      <video controls preload="metadata" src={mediaUrls[item.id]} className="media-player" />
                    )}

                    {activeType === 'audio' && (
                      <div className="audio-tile">
                        <p className="audio-title">{item.originalName}</p>
                        {mediaUrls[item.id] ? (
                          <audio controls preload="metadata" src={mediaUrls[item.id]} className="audio-player" />
                        ) : (
                          <div className="loading-tile">Loading audio...</div>
                        )}
                      </div>
                    )}

                    {!mediaUrls[item.id] && activeType !== 'audio' ? (
                      <div className="loading-tile">Loading preview...</div>
                    ) : null}

                    <div className="photo-meta">
                      <p>{item.originalName}</p>
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        )}

        {(status || error) && (
          <section className="notice-wrap">
            {status && <p className="notice success">{status}</p>}
            {error && <p className="notice error">{error}</p>}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
