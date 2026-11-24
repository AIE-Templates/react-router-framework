import { deals, usd } from "./sales-data";

import classes from "./home.route.module.css";

export default function Deals() {
  return (
    <div className={classes.layoutDemo}>
      <header className={classes.pageHeader}>
        <h1 id="deals-title">Deals</h1>
      </header>
      <section className={classes.tableCard} aria-labelledby="deals-title">
        <table className={classes.salesTable}>
          <thead>
            <tr>
              <th>Account</th>
              <th>Stage</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => (
              <tr key={deal.account}>
                <th scope="row">{deal.account}</th>
                <td>
                  <span className={classes.stage}>{deal.stage}</span>
                </td>
                <td>{usd.format(deal.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
