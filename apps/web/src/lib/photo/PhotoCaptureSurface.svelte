<!--
  Photo capture surface (T10 / T14 — design-system §4.E).

  Source obligations:
    - a11y-review §5.6 — no "use my current location" affordance.
    - ADR-0011 amendment (HG-5) — location is free-text or location_id;
      never derived from EXIF or geolocation API. The capture surface
      MUST NOT offer a "use my current location" button.
    - i18n keys: photo.capture.*, photo.preview.*, photo.location.*.

  This component is a minimal scaffold; the full UX (capture-then-preview,
  attach affordance, status banners) is wired in T10.1 alongside the
  inspection-form binding. The structural assertion under test is the
  absence of a location-affordance surface.
-->
<script lang="ts">
  import { t } from '../i18n';
  // Free-text location field; explicitly NOT a geolocation button.
  let locationText = '';
  // Banner key — bound to the queue's `ui.lastBannerKey` when this
  // component is mounted inside an inspection session. For the standalone
  // mount under test, the banner is null.
  let bannerKey = null;
  void bannerKey;
</script>

<section aria-labelledby="photo-capture-heading">
  <h2 id="photo-capture-heading">{t('photo.capture.heading')}</h2>

  <p id="photo-gps-advisory">{t('photo.capture.advisory_inline')}</p>

  <label for="photo-location-text">{t('photo.location.label')}</label>
  <input
    id="photo-location-text"
    type="text"
    aria-describedby="photo-gps-advisory"
    bind:value={locationText}
    autocomplete="off"
  />

  <button type="button">{t('photo.capture.button')}</button>
  <!--
    Deliberately omitted: any "use my current location" / geolocation
    button. The location source is free-text or the C1 location list
    only. See a11y-review §5.6 and ADR-0011 amendment.
  -->
</section>
