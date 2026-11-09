import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache needed: the app renders on the client and fetches its data from the API.
export default defineCloudflareConfig({});
