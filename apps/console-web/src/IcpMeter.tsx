export type IcpBand = 'high' | 'med' | 'low';

const ICP_LABEL: Record<IcpBand, string> = {
  high: 'High fit',
  med: 'Medium',
  low: 'Low',
};

export function IcpMeter({ band }: { band: IcpBand }) {
  return (
    <span className={`icp ${band}`}>
      <span className="icp-bars">
        <i />
        <i />
        <i />
      </span>
      <span className="icp-label">{ICP_LABEL[band]}</span>
    </span>
  );
}
