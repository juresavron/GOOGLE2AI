// The pages a stranger can read: privacy and terms.
//
// They exist because this service asks people to hand over access to their Google Search Console,
// and Google's own OAuth verification asks for both before it will let an app out of Testing. So
// they are not decoration — an unpublished consent screen expires every tenant's refresh token after
// seven days, and these pages are part of what fixes that.
//
// THEY NAME A REAL OPERATOR OR THEY SAY THEY CANNOT. Left unconfigured, each page says so in plain
// red rather than naming a company that does not exist: a privacy policy naming nobody is worse
// than no policy, and an invented one would be a lie told to someone deciding whether to trust this
// with their data. Same rule as imap2ai and whatsapp2ai, same reason.
import type { Express } from 'express';
import type { Config } from './env.ts';
import { banner, esc, page } from './html.ts';

const operatorBlock = (cfg: Config): string => {
  const { name, contact, law } = cfg.operator;
  if (!name || !contact) {
    // A blocking state, so it gets the one banner this page is allowed (rule 7 in html.ts).
    return banner(
      'danger',
      `<strong>This deployment has not said who runs it.</strong> Set OPERATOR_NAME, OPERATOR_CONTACT and
       OPERATOR_LAW. Until then this page cannot tell you who is responsible for your data, and you
       should not connect a Google account to it.`,
    );
  }
  return `<div class="card"><p style="margin:0">This service is operated by <strong>${esc(name)}</strong>.
    Questions, requests and complaints: <strong>${esc(contact)}</strong>.${law ? ` Governed by the law of ${esc(law)}.` : ''}</p></div>`;
};

export function mountPages(app: Express, cfg: Config): void {
  app.get('/privacy', (_req, res) => {
    res.type('html').send(
      page(
        'Privacy · GOOGLE2AI',
        `<h1>Privacy</h1>` +
          operatorBlock(cfg) +
          `<div class="card prose">
           <h2>What this service touches</h2>
           <p>When you connect a Google account, Google gives this service a token for the Search
           Console properties that account can already see. The scopes requested are
           <code>webmasters</code> and <code>indexing</code>.</p>
           <p><strong>That includes writing.</strong> Reading — search analytics, index status,
           sitemap status — is what it does by default. It can also submit and remove sitemaps, add
           and remove properties from the account, and send Indexing API notifications. Those tools
           are <strong>switched off unless you turn them on</strong> for your connection, and they
           stay off until you do. What it cannot do at any setting: read or send your mail, touch any
           other Google product, or change the content of your site.</p>
           <p>It also reads your email address from Google, for one reason: to show you which Google
           account you connected. Connecting the wrong one is the most common mistake, and without an
           address on screen it looks identical to having no properties at all.</p>

           <h2>What is stored</h2>
           <ul>
             <li>Your sign-in email and password, held by Supabase Auth. This service never sees the password.</li>
             <li>The Google refresh token, encrypted with AES-256-GCM under a key that lives only in
                 the server's environment and never in the database.</li>
             <li>The name you gave the connection, the Google address that consented, and the property you chose.</li>
             <li>A log of which tools were called, whether each worked, and how long it took.</li>
           </ul>

           <h2>What is not stored</h2>
           <p>Your Search Console data is not copied here. Every answer is fetched from Google when
           you ask for it and passed straight back. The call log records the <em>name</em> of the tool
           and a coarse error code — never a search term, a page URL or a property name — so it cannot
           become a second copy of your traffic.</p>
           <p>Connector URLs are not stored either. Only a SHA-256 hash of each is kept, which is why
           a lost one is reissued rather than looked up.</p>

           <h2>Who it is shared with</h2>
           <p>Nobody. Data moves between Google, this server, and the Claude client holding your
           connector URL. There are no analytics, no third-party scripts and no advertising.</p>

           <h2>Ending it</h2>
           <p>Deleting a connection from the dashboard revokes its connector URLs immediately and
           asks Google to revoke the grant, after which the stored token is deleted. You can also
           revoke it yourself at <code>myaccount.google.com/permissions</code> at any time, which
           this service cannot prevent or undo.</p>
           <p class="muted">Google's own handling of the data is covered by Google's privacy policy, not this one.</p>
           </div>`,
        { description: 'What GOOGLE2AI reads, what it stores, and what it never copies.', footer: '<a href="/">Home</a> · <a href="/terms">Terms</a>' },
      ),
    );
  });

  app.get('/terms', (_req, res) => {
    res.type('html').send(
      page(
        'Terms · GOOGLE2AI',
        `<h1>Terms</h1>` +
          operatorBlock(cfg) +
          `<div class="card prose">
           <h2>What it does</h2>
           <p>This service reads Google Search Console on your behalf and exposes it to an AI client
           over the Model Context Protocol. It can also make a small number of changes — submitting and
           removing sitemaps, adding and removing properties, and Indexing API notifications — but
           only for connections where you have explicitly switched writing on.</p>

           <h2>Your side</h2>
           <ul>
             <li>Connect only Google accounts you are entitled to use.</li>
             <li>Your connector URL is a credential. Anyone holding it can read the property it is
                 bound to — and, if you have enabled writing for that connection, make the changes
                 listed above. Treat it like a password; revoke it in the dashboard if it leaks.</li>
             <li>Enabling writing points an AI client at operations that calling again does not undo.
                 Removing a property in particular needs ownership verification to restore. Leave it
                 off unless you want it.</li>
             <li>Do not use it to work around Google's API quotas or terms.</li>
           </ul>

           <h2>Our side</h2>
           <p>The service is provided as-is, with no warranty. It depends on Google's API, which can
           change, rate-limit or fail independently of anything here. Search Console data is roughly
           three days behind and keeps sixteen months of history; neither is something this service
           can alter.</p>

           <h2>Ending it</h2>
           <p>Delete your connections at any time from the dashboard. The operator may suspend a
           connection that is abusing the API or putting the deployment's quota at risk, and will say
           so at the contact address above.</p>
           </div>`,
        { description: 'The terms GOOGLE2AI is provided under.', footer: '<a href="/">Home</a> · <a href="/privacy">Privacy</a>' },
      ),
    );
  });
}
