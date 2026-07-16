import { clockTime } from '../lib/format';

/**
 * TxLINE provenance badge (FR-54): every displayed number that originates
 * from TxLINE carries this, with packet ids + timestamp on hover.
 */
export function TxBadge({ packetIds, asOf }: { packetIds: string[]; asOf: number }) {
  const title = `TxLINE packets @ ${clockTime(asOf)}\n${packetIds.slice(0, 6).join('\n')}${packetIds.length > 6 ? `\n… +${packetIds.length - 6} more` : ''}`;
  return (
    <span
      title={title}
      className="ml-1 inline-block cursor-help rounded border border-terminal-border px-1 text-[9px] uppercase tracking-wider text-terminal-dim align-middle"
    >
      TxLINE
    </span>
  );
}
