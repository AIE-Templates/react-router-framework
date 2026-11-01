import { DemoIcon } from "./demo-icon";

import classes from "./welcome.module.css";

export function Welcome() {
  return (
    <section id="resources" aria-label="Welcome resources" className={classes.demoResources}>
      <div className={classes.demoSectionHeading}>
        <h2>Keep building</h2>
        <span>A few useful places to go next.</span>
      </div>
      <div className={classes.demoResourceGrid}>
        <a
          href="https://reactrouter.com/docs"
          target="_blank"
          rel="noreferrer"
          className={classes.demoResource}
          aria-label="React Router Docs"
        >
          <span className={classes.demoIconBox}>
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
          className={classes.demoResource}
          aria-label="Join Discord"
        >
          <span className={classes.demoIconBox}>
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
