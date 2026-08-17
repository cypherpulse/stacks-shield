import { LegalLayout } from "@/features/legal/LegalLayout";

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated="August 2026">
      <p>
        Stacks Shield is a non-custodial, privacy-focused protocol. This policy explains what data the
        reference Service does and does not handle. It applies to the web interface and supporting
        services on Stacks Testnet.
      </p>

      <h2>Our approach: minimise by design</h2>
      <p>
        The Protocol is built to <strong>not</strong> collect your personal information. There are no
        user accounts, and we do not ask for your name, email, or identity. Sensitive values &mdash;
        note amounts, note secrets, and viewing keys &mdash; are derived and processed{" "}
        <strong>locally in your browser</strong> and are never sent to our servers.
      </p>

      <h2>What stays on your device</h2>
      <ul>
        <li>
          Your wallet keys and the secrets used to derive and spend notes &mdash; these never leave
          your device.
        </li>
        <li>
          A local note vault (browser storage) holding your notes as <strong>encrypted</strong>{" "}
          ciphertext, so you don&rsquo;t lose them on refresh. You can clear it via your browser at any
          time.
        </li>
      </ul>

      <h2>What our services store</h2>
      <p>
        The read-only indexer/API stores only public, on-chain data and{" "}
        <strong>opaque encrypted note payloads</strong> &mdash; never amounts, secrets, viewing keys,
        or links between a deposit and a withdrawal. Encrypted payloads can be decrypted only by the
        owner&rsquo;s viewing key, which we never receive.
      </p>

      <h2>Technical data</h2>
      <p>
        Like any web service, our servers and hosting/infrastructure providers may automatically
        process technical information necessary to operate the Service &mdash; such as IP addresses,
        request timestamps, and error logs. Blockchain transactions you submit are, by nature,{" "}
        <strong>public and permanent</strong> on the Stacks network and are not controlled by us.
      </p>

      <h2>Third-party services</h2>
      <p>The interface interacts with third parties that may receive your request/IP data, including:</p>
      <ul>
        <li>the Stacks network and RPC/API providers (e.g. Hiro) to read and broadcast transactions;</li>
        <li>the zkVerify network, which verifies zero-knowledge proofs;</li>
        <li>a price feed (e.g. CoinGecko) to display indicative USD values;</li>
        <li>a testnet faucet service, if you request test assets;</li>
        <li>hosting providers that serve the interface and services.</li>
      </ul>
      <p>
        These parties operate under their own privacy practices, which we do not control. A wallet
        address you interact with is public on-chain data.
      </p>

      <h2>Cookies and analytics</h2>
      <p>
        The reference interface does not use tracking cookies to profile you. Third-party services it
        calls may log requests as described above.
      </p>

      <h2>Data we do not sell</h2>
      <p>We do not sell your data. There is no personal data collected by us to sell.</p>

      <h2>Children</h2>
      <p>The Service is not directed to children and should not be used by anyone under 18.</p>

      <h2>Changes</h2>
      <p>
        We may update this policy from time to time; the &ldquo;Last updated&rdquo; date reflects the
        latest revision.
      </p>

      <p>
        See also our <a href="/terms">Terms of Service</a>.
      </p>
    </LegalLayout>
  );
}
