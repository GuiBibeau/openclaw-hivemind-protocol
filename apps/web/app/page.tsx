import HiveDashboard from "./components/HiveDashboard";

export default function HomePage() {
  return (
    <main className="page">
      <div className="ambient">
        <div className="glow glow-a" />
        <div className="glow glow-b" />
        <div className="grid-overlay" />
      </div>
      <HiveDashboard />
    </main>
  );
}
