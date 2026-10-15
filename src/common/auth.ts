import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppConfig, CONFIG } from '../config';
import { AppError } from './errors';

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** แอดมิน/Dashboard: header X-Admin-Token และ X-Actor (ชื่อคนกด เก็บลง audit log) */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!safeEqual(req.header('x-admin-token') ?? '', this.cfg.adminToken)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Invalid admin token');
    }
    const actor = (req.header('x-actor') ?? 'admin').slice(0, 64);
    (req as any).actor = actor;
    return true;
  }
}

/** bot agent: header X-Agent-Token + X-Bot-Id */
@Injectable()
export class AgentGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!safeEqual(req.header('x-agent-token') ?? '', this.cfg.agentToken)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Invalid agent token');
    }
    const botId = req.header('x-bot-id');
    if (!botId) throw new AppError(HttpStatus.BAD_REQUEST, 'MISSING_BOT_ID', 'X-Bot-Id header is required');
    (req as any).botId = botId;
    return true;
  }
}
