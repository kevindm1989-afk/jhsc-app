// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces.
declare global {
  namespace App {
    interface Error {
      code?: string;
      request_id?: string;
    }
    interface Locals {
      request_id: string;
    }
    // SvelteKit boilerplate: these are intentionally empty until the
    // implementer of T05+ attaches per-route data shapes.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface PageData {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface PageState {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Platform {}
  }
}

export {};
