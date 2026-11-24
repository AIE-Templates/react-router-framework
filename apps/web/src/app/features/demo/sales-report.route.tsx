import { deals, pipelineValue, usd } from "./sales-data";

import classes from "./home.route.module.css";

export default function SalesReport() {
  return (
    <div className={classes.layoutDemo}>
      <header className={classes.pageHeader}>
        <h1>Sales report</h1>
      </header>
      <dl className={classes.metrics}>
        <div>
          <dt>Open deals</dt>
          <dd>{deals.length}</dd>
        </div>
        <div>
          <dt>Pipeline value</dt>
          <dd>{usd.format(pipelineValue)}</dd>
        </div>
      </dl>
      <section className={classes.demoCard}>
        <h2>Pipeline by stage</h2>
        <ul className={classes.breakdown}>
          {deals.map((deal) => (
            <li key={deal.account}>
              <div>
                <strong>{deal.stage}</strong>
                <span>{usd.format(deal.amount)}</span>
              </div>
              <meter aria-label={deal.stage} max={pipelineValue} value={deal.amount} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
