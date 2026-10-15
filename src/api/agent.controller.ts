import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { WorkService } from '../agent/work.service';
import { AgentGuard } from '../common/auth';
import { DeployService } from '../deploy/deploy.service';
import { FailDto, LeaseDto, ProviderTopupDto } from '../dto';

const botId = (req: Request) => (req as any).botId as string;

/** API สำหรับ bot agent (X-Agent-Token + X-Bot-Id) — heartbeat/คำสั่งไปทาง WebSocket ส่วนงานออเดอร์ใช้ REST */
@ApiTags('agent')
@ApiSecurity('agent')
@UseGuards(AgentGuard)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly work: WorkService,
    private readonly deploy: DeployService,
  ) {}

  /** 200 + งาน หรือ 204 ถ้าไม่มีงาน / 409 SYSTEM_PAUSED, BOT_NOT_READY, BOT_BUSY */
  @Post('claim')
  async claim(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const job = await this.work.claim(botId(req));
    if (!job) res.status(204);
    else res.status(200);
    return job ?? undefined;
  }

  @Post('orders/:id/lease')
  @HttpCode(200)
  lease(@Param('id') id: string, @Body() dto: LeaseDto, @Req() req: Request) {
    return this.work.extendLease(botId(req), id, dto.lease_token);
  }

  @Post('orders/:id/complete')
  @HttpCode(200)
  complete(@Param('id') id: string, @Body() dto: LeaseDto, @Req() req: Request) {
    return this.work.complete(botId(req), id, dto.lease_token);
  }

  @Post('orders/:id/fail')
  @HttpCode(200)
  fail(@Param('id') id: string, @Body() dto: FailDto, @Req() req: Request) {
    return this.work.fail(botId(req), id, dto.lease_token, dto.code, dto.message);
  }

  /** ดาวน์โหลด package (agent ตรวจ sha256 ใน header เทียบกับที่ได้รับในคำสั่ง deploy) */
  @Get('packages/:id')
  async download(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const p = await this.deploy.content(String(id));
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${p.filename.replace(/"/g, '')}"`);
    res.setHeader('x-sha256', p.sha256);
    res.end(p.content);
  }

  /** provider เติมเกม (จำลอง) — topup_key เดิมไม่เติมซ้ำ */
  @Post('provider/topup')
  @HttpCode(200)
  topup(@Body() dto: ProviderTopupDto, @Req() req: Request) {
    return this.work.providerTopup(botId(req), dto.topup_key, dto.external_order_id);
  }
}
