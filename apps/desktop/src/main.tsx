import { createRoot } from 'react-dom/client';
import App from './app/App.tsx';
import './styles/index.css';
import { applyAppAppearance, loadAppSettings } from './app/lib/app-settings';

applyAppAppearance(loadAppSettings());
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is missing');
createRoot(rootElement).render(<App />);
