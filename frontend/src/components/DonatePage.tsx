export function DonatePage({ onBack }: { onBack: () => void }) {
  return (
    <div className="donate-page">
      <button className="donate-back" onClick={onBack}>&larr; Back to search</button>
      <h1>Support jlc-search</h1>
      <p className="donate-subtitle">
        This tool is free and open source. If it saved you time, consider helping cover our hosting costs.
      </p>
      <p className="donate-subtitle">
        This infrastructure costs $35/month because Asian servers with reasonable bandwidth are particularly expensive.
        If I get enough donations I will start a Europe server, then a US one.
      </p>

      <div className="donate-grid">
        <div className="donate-card">
          <h2>WeChat Pay</h2>
          <img src="/qr1.webp" alt="WeChat Pay QR" className="donate-qr" />
        </div>

        <div className="donate-card">
          <h2>Alipay</h2>
          <img src="/qr2.webp" alt="Alipay QR" className="donate-qr" />
        </div>
      </div>

      <div className="donate-other">
        <p>Other ways to support:</p>
        <div className="donate-links">
          <a href="https://github.com/casimir-engineering/jlc-search" target="_blank" rel="noopener noreferrer" className="donate-link-btn">
            Star on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
