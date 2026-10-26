import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getWindowDeviceClient } from './deviceClient';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={getWindowDeviceClient()} />
  </StrictMode>,
);
