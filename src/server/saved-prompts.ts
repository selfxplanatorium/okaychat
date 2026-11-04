import { Hono } from "hono";
import type { AppEnv } from "./auth.js";

export const savedPromptRoutes = new Hono<AppEnv>();
