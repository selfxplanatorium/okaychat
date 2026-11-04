import { Hono } from "hono";
import type { AppEnv } from "./auth.js";

export const messageAnnotationRoutes = new Hono<AppEnv>();
