import {createHandler} from "./server.mjs";
Deno.serve(createHandler({
  getKey: () => Deno.env.get("INTEGRATIONS_API_KEY"),
}));
