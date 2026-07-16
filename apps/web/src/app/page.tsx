import dynamic from 'next/dynamic';

// The terminal is wallet- and WebSocket-driven: client-only by nature.
const App = dynamic(() => import('../components/App').then((m) => m.App), { ssr: false });

export default function Home() {
  return <App />;
}
