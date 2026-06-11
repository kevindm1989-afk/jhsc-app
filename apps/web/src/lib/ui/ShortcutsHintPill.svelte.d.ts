/**
 * Type declaration so a `<script lang="ts">` consumer can import this
 * JSDoc-script component without a TS module-resolution error. The
 * component itself stays JSDoc-typed per G-T07-13.
 */
import { SvelteComponent } from 'svelte';

export default class ShortcutsHintPill extends SvelteComponent<Record<string, never>> {}
