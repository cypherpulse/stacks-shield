import { LegalLayout } from "@/features/legal/LegalLayout";

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated="August 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of Stacks Shield (the
        &ldquo;Protocol&rdquo;), an open-source, non-custodial privacy protocol on the Stacks
        blockchain, together with its reference web interface and services (collectively, the
        &ldquo;Service&rdquo;). By accessing or using the Service you agree to these Terms. If you do
        not agree, do not use the Service.
      </p>

      <h2>1. Testnet, experimental software</h2>
      <p>
        The Service currently runs only on <strong>Stacks Testnet</strong>. It is experimental,
        unaudited software provided for testing and evaluation. Testnet assets (STX, sBTC, USDCx and
        other tokens) have <strong>no monetary value</strong>. Do not use the Service with assets of
        real value. Functionality may change, break, or be discontinued at any time.
      </p>

      <h2>2. Non-custodial &mdash; you control your funds</h2>
      <p>
        The Protocol is non-custodial. Your keys and note secrets are derived from your own wallet on
        your own device and are never transmitted to us. We do not hold, control, or have the ability
        to move, freeze, or recover your assets or notes. You are solely responsible for securing your
        wallet, keys, and any locally stored data. If you lose access to your wallet or the data
        needed to spend a note, your notes may become permanently unrecoverable.
      </p>

      <h2>3. No warranty</h2>
      <p>
        The Service is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>,
        without warranties of any kind, express or implied, including merchantability, fitness for a
        particular purpose, title, and non-infringement. We do not warrant that the Service will be
        uninterrupted, secure, error-free, or that any defect will be corrected.
      </p>

      <h2>4. Privacy is not guaranteed</h2>
      <p>
        The Protocol is designed to hide note amounts and ownership using zero-knowledge proofs.
        However, practical privacy depends on factors outside our control &mdash; the size of the
        anonymity set, your own behaviour, network-level metadata, and the transparent amounts and
        addresses of deposits and withdrawals. We make <strong>no guarantee of anonymity or
        unlinkability</strong>. Do not rely on the Service for privacy where the consequences of
        de-anonymisation would be serious.
      </p>

      <h2>5. Not financial, legal, or tax advice</h2>
      <p>
        Nothing in the Service constitutes financial, investment, legal, accounting, or tax advice.
        You are responsible for evaluating your own use and consulting your own advisors.
      </p>

      <h2>6. Your responsibilities and lawful use</h2>
      <p>You agree that you will not use the Service to:</p>
      <ul>
        <li>violate any applicable law, regulation, or sanctions programme;</li>
        <li>launder money, finance terrorism, or facilitate any other illegal activity;</li>
        <li>infringe the rights of others or interfere with the operation of the Service.</li>
      </ul>
      <p>
        You are solely responsible for ensuring your use of the Service is lawful in your
        jurisdiction. Privacy technology is regulated differently across jurisdictions; it is your
        responsibility to understand and comply with the rules that apply to you.
      </p>

      <h2>7. Third-party services</h2>
      <p>
        The Service interacts with third-party infrastructure, including the Stacks network, RPC/API
        providers, the zkVerify verification network, price feeds, a testnet faucet, and hosting
        providers. We do not control these services and are not responsible for their availability,
        conduct, or data practices. Your use of them may be subject to their own terms.
      </p>

      <h2>8. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, in no event will the Protocol&rsquo;s contributors,
        maintainers, or affiliates be liable for any indirect, incidental, special, consequential, or
        exemplary damages, or for any loss of assets, profits, data, or goodwill, arising out of or in
        connection with your use of the Service &mdash; even if advised of the possibility. Because the
        Service is free, open-source, testnet software, our aggregate liability is limited to the
        greatest extent the law allows.
      </p>

      <h2>9. Open source</h2>
      <p>
        The Protocol is open source and licensed under the MIT License. The software is provided under
        the terms of that license; these Terms govern your use of the reference Service.
      </p>

      <h2>10. Changes</h2>
      <p>
        We may update these Terms from time to time. Continued use of the Service after changes take
        effect constitutes acceptance of the revised Terms.
      </p>

      <p>
        See also our <a href="/privacy">Privacy Policy</a>.
      </p>
    </LegalLayout>
  );
}
