import { DemoIcon } from "./demo-icon";
import { deals, inboundLeads, pipelineValue, recentLeads, usd } from "./sales-data";

import classes from "./home.route.module.css";

export function PipelineOverview() {
  return (
    <>
      <dl className={classes.metrics}>
        <div>
          <dt>
            Inbound leads <DemoIcon name="people" />
          </dt>
          <dd>{inboundLeads.reduce((total, [, count]) => total + count, 0)}</dd>
          <dd>January – June</dd>
        </div>
        <div>
          <dt>
            Open deals <DemoIcon name="briefcase" />
          </dt>
          <dd>{deals.length}</dd>
          <dd>In the current pipeline</dd>
        </div>
        <div>
          <dt>
            Pipeline value <DemoIcon name="chart" />
          </dt>
          <dd>{usd.format(pipelineValue)}</dd>
          <dd>Across open deals</dd>
        </div>
      </dl>
      <div className={classes.analytics}>
        <section className={classes.demoCard}>
          <h2>Lead activity</h2>
          <p className={classes.caption}>Monthly inbound volume</p>
          <ol className={classes.plot} aria-label="Inbound leads by month">
            {inboundLeads.map(([month, count]) => (
              <li key={month}>
                <span className={classes.bar} style={{ height: `${(count / 30) * 100}%` }}>
                  <strong>{count}</strong>
                </span>
                <span className={classes.month}>{month}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className={classes.demoCard}>
          <h2>Recent leads</h2>
          <ul className={classes.contacts}>
            {recentLeads.map((lead) => (
              <li key={lead.account}>
                <span aria-hidden="true" className={classes.avatar}>
                  {lead.initials}
                </span>
                <div>
                  <strong>{lead.contact}</strong>
                  <small>{lead.account}</small>
                </div>
                <span className={classes.source}>{lead.source}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
