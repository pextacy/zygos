export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-3xl tracking-widest text-terminal-accent">ZYGOS</h1>
      <p className="max-w-md text-center text-sm text-terminal-dim">
        Real-time fair value and one-click lock-in for on-chain prediction market positions.
        Terminal UI ships on Day 2 (PLAN.md T2.4) — nothing is displayed until real TxLINE
        data and real wallet positions are wired in.
      </p>
    </main>
  );
}
