import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// If anything in the app crashes, show the reason and a way out instead of a blank screen.
class Guard extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    const reset = () => { try { localStorage.removeItem('viz-settings'); } catch { /* ignore */ } location.reload(); };
    return (
      <div className="crash">
        <h2>Vizualizator xatoga uchradi / Произошла ошибка</h2>
        <p>Quyidagi matnni Claude'ga yuboring. Sozlamalarni tozalab qayta ochish ham mumkin.</p>
        <pre>{String(err && (err.stack || err.message) || err).slice(0, 1500)}</pre>
        <button className="primary" onClick={reset}>Sozlamalarni tozalab qayta ochish</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(<Guard><App /></Guard>);
