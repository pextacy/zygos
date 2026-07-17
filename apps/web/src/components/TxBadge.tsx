import { clockTime } from '../lib/format';

/**
 * TxLINE provenance badge (FR-54): every displayed number that originates
 * from TxLINE carries this, with packet ids + timestamp on hover.
 */
export function TxBadge({ packetIds, asOf }: { packetIds: string[]; asOf: number }) {
  const title = `TxLINE packets @ ${clockTime(asOf)}\n${packetIds.slice(0, 6).join('\n')}${packetIds.length > 6 ? `\n… +${packetIds.length - 6} more` : ''}`;
  return (
    <span title={title} className="ml-1.5 inline-block cursor-help rounded-full bg-primary-fixed px-2 py-px align-middle font-sans text-[10px] font-semibold tracking-[0.1em] text-primary">
      TxLINE
    </span>
  );
}
