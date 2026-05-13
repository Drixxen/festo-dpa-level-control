export default function Portal() {
  const dashboardUrl = "http://10.42.0.1:3000/";

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }

        html, body {
          height: 100%;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background:
            radial-gradient(circle at 20% 15%, rgba(255,255,255,0.07), transparent 30%),
            linear-gradient(145deg, #20252c, #101318 58%, #0b0e12);
          color: #eef2f6;
        }

        .page {
          min-height: 100svh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 2rem 1.5rem;
          gap: 2.5rem;
        }

        .card {
          width: 100%;
          max-width: 380px;
          background: rgba(38, 44, 53, 0.6);
          border: 1px solid rgba(235, 240, 247, 0.12);
          border-radius: 20px;
          padding: 2.5rem 2rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1.5rem;
          backdrop-filter: blur(16px);
          box-shadow: 0 24px 70px rgba(0,0,0,0.4);
        }

        .icon {
          width: 72px;
          height: 72px;
          border-radius: 18px;
          background: linear-gradient(135deg, rgba(121,199,232,0.18), rgba(130,214,173,0.12));
          border: 1px solid rgba(121,199,232,0.25);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .icon svg {
          width: 38px;
          height: 38px;
          opacity: 0.9;
        }

        .labels {
          text-align: center;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }

        .title {
          font-size: 1.35rem;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: #eef2f6;
        }

        .subtitle {
          font-size: 0.875rem;
          color: #a0a9b5;
          line-height: 1.5;
        }

        .divider {
          width: 100%;
          height: 1px;
          background: rgba(235, 240, 247, 0.1);
        }

        .btn {
          display: block;
          width: 100%;
          padding: 0.9rem 1.5rem;
          background: linear-gradient(135deg, #79c7e8, #82d6ad);
          color: #0b0e12;
          font-size: 1rem;
          font-weight: 700;
          text-align: center;
          text-decoration: none;
          border-radius: 12px;
          letter-spacing: 0.01em;
          box-shadow: 0 4px 20px rgba(121,199,232,0.3);
          transition: opacity 0.15s;
        }

        .btn:active { opacity: 0.85; }

        .hint {
          font-size: 0.78rem;
          color: #6b7582;
          text-align: center;
          line-height: 1.6;
        }

        .hint code {
          font-family: ui-monospace, monospace;
          color: #a0a9b5;
          background: rgba(255,255,255,0.06);
          padding: 0.1em 0.35em;
          border-radius: 4px;
        }
      `}</style>

      <div className="page">
        <div className="card">

          {/* Icon */}
          <div className="icon">
            <svg viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Tank */}
              <rect x="11" y="10" width="16" height="20" rx="2.5" stroke="#79c7e8" strokeWidth="1.6" fill="none"/>
              {/* Water fill */}
              <rect x="12.8" y="20" width="12.4" height="8.2" rx="1.2" fill="rgba(121,199,232,0.35)"/>
              {/* Level line */}
              <line x1="11" y1="20" x2="27" y2="20" stroke="#79c7e8" strokeWidth="1.2" strokeDasharray="2 1.5"/>
              {/* Pipe in */}
              <line x1="19" y1="6" x2="19" y2="10" stroke="#82d6ad" strokeWidth="1.6" strokeLinecap="round"/>
              {/* Pipe out */}
              <line x1="19" y1="30" x2="19" y2="34" stroke="#82d6ad" strokeWidth="1.6" strokeLinecap="round"/>
              {/* Arrow down */}
              <polyline points="16.5,31.5 19,34 21.5,31.5" stroke="#82d6ad" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>

          {/* Text */}
          <div className="labels">
            <div className="title">Festo EduKit PA</div>
            <div className="subtitle">Füllstandsregelung &amp; PID-Dashboard</div>
          </div>

          <div className="divider" />

          {/* CTA */}
          <a className="btn" href={dashboardUrl}>
            Dashboard öffnen →
          </a>

          <div className="hint">
            Falls sich kein Browser öffnet, tippe im Browser auf:<br />
            <code>10.42.0.1:3000</code>
          </div>

        </div>
      </div>
    </>
  );
}
