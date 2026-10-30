import { DemoIcon } from "./demo-icon";

export function Welcome() {
  return (
    <section id="resources" aria-label="Welcome resources" className="demo-resources">
      <div className="demo-section-heading">
        <h2>Keep building</h2>
        <span>A few useful places to go next.</span>
      </div>
      <div className="demo-resource-grid">
        <a
          href="https://reactrouter.com/docs"
          target="_blank"
          rel="noreferrer"
          className="demo-resource"
          aria-label="React Router Docs"
        >
          <span className="demo-icon-box">
            <DemoIcon name="book" />
          </span>
          <span>
            <strong>React Router Docs</strong>
            <span>Routing, data, and everything in between.</span>
          </span>
          <DemoIcon name="arrow" />
        </a>
        <a
          href="https://rmx.as/discord"
          target="_blank"
          rel="noreferrer"
          className="demo-resource"
          aria-label="Join Discord"
        >
          <span className="demo-icon-box">
            <DemoIcon name="code" />
          </span>
          <span>
            <strong>Join the community</strong>
            <span>Ask a question. Share what you&apos;re building.</span>
          </span>
          <DemoIcon name="arrow" />
        </a>
      </div>
    </section>
  );
}
