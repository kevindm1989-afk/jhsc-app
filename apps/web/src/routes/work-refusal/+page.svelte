<script lang="ts">
  /**
   * /work-refusal — coming-soon placeholder for the OHSA s. 43
   * work-refusal capture surface.
   *
   * Section 43 protects a worker who refuses work they have reason to
   * believe is dangerous. The full capture surface (stage-gated entry
   * across worker refusal → s. 43(4) joint investigation → s. 43(8)
   * Ministry escalation, worker-side encryption, audit chain) is a
   * follow-on product surface; library scaffolding for the stage
   * machine doesn't ship yet. The placeholder lands the URL + the
   * four-bullet contract so a worker who navigates here from a future
   * nav link doesn't 404 and sees what's coming. Same pattern as
   * PRs #133, #136, #138.
   *
   * Replaces this file on work-refusal-module mount: a thin wiring
   * shell that mounts the production stage-gated capture flow.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.workRefusalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card work-refusal-card" data-testid="work-refusal-page">
  <h1>{t('common.workRefusalPage.heading')}</h1>

  <p class="muted" data-testid="work-refusal-coming-soon-notice">
    {t('common.workRefusalPage.coming_soon_body')}
  </p>

  <h2>{t('common.workRefusalPage.what_this_will_do_heading')}</h2>
  <ul class="work-refusal-bullets">
    <li>{t('common.workRefusalPage.bullet_right_to_refuse')}</li>
    <li>{t('common.workRefusalPage.bullet_stage_gated')}</li>
    <li>{t('common.workRefusalPage.bullet_certified_member_visibility')}</li>
    <li>{t('common.workRefusalPage.bullet_audit_full_chain')}</li>
  </ul>

  <p>
    <a href="/" data-testid="work-refusal-back-to-home">
      {t('common.workRefusalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .work-refusal-card {
    margin-block-start: 1rem;
  }
  .work-refusal-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .work-refusal-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
