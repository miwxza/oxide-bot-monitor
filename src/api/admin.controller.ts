import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { BotsService } from '../bots/bots.service';
import { CommandsService } from '../bots/commands.service';
import { AdminGuard } from '../common/auth';
import { DbService } from '../db/db.service';
import { DeployService, MAX_PACKAGE_BYTES } from '../deploy/deploy.service';
import { CommandDto, CreateOrderDto, DeployDto, KillSwitchDto, NoteDto, ResolveOrderDto } from '../dto';
import { OrdersService, publicOrder } from '../orders/orders.service';
import { DashboardService } from '../realtime/dashboard.service';
import { SystemService } from '../system/system.service';

const actor = (req: Request) => (req as any).actor as string;

@ApiTags('orders')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 201 = สร้างใหม่, 200 = external_order_id เดิมข้อมูลเดิม (idempotent) */
  @Post()
  async create(@Body() dto: CreateOrderDto, @Res({ passthrough: true }) res: Response) {
    const { order, created } = await this.orders.create({ ...dto, currency: dto.currency ?? 'THB' });
    res.status(created ? 201 : 200);
    return order;
  }

  @Get()
  list(@Query('status') status?: string, @Query('limit') limit = '50') {
    return this.orders.list(status, Math.min(Math.max(Number(limit) || 50, 1), 200));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  @Get(':id/timeline')
  timeline(@Param('id') id: string) {
    return this.orders.timeline(id);
  }

  @Post(':id/requeue')
  @HttpCode(200)
  async requeue(@Param('id') id: string, @Body() dto: NoteDto, @Req() req: Request) {
    return publicOrder(await this.orders.requeue(id, actor(req), dto.note));
  }

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@Param('id') id: string, @Body() dto: ResolveOrderDto, @Req() req: Request) {
    return publicOrder(await this.orders.resolve(id, dto.outcome, actor(req), dto.note));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Req() req: Request) {
    return publicOrder(await this.orders.cancel(id, actor(req)));
  }
}

@ApiTags('bots')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller()
export class BotsController {
  constructor(
    private readonly bots: BotsService,
    private readonly commands: CommandsService,
  ) {}

  @Get('bots')
  list() {
    return this.bots.list();
  }

  /** รายละเอียด + log/metrics ของเครื่อง */
  @Get('bots/:id')
  detail(@Param('id') id: string) {
    return this.bots.detail(id);
  }

  /** 202 = รับเข้าคิว (executor ส่งต่อให้ simulator), 200 = Idempotency-Key เดิม */
  @Post('bots/:id/commands')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  async command(
    @Param('id') id: string,
    @Body() dto: CommandDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key?: string,
  ) {
    const { command, created } = await this.commands.request(id, dto.command, actor(req), key || undefined);
    res.status(created ? 202 : 200);
    return command;
  }

  @Get('commands/:id')
  getCommand(@Param('id', ParseIntPipe) id: number) {
    return this.commands.get(String(id));
  }
}

@ApiTags('system')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller()
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly dashboard: DashboardService,
    private readonly db: DbService,
  ) {}

  @Get('system')
  get() {
    return this.system.get();
  }

  /** Kill-switch: accepting_orders=false → ทุกเครื่องปฏิเสธงานใหม่ทันที */
  @Put('system/kill-switch')
  set(@Body() dto: KillSwitchDto, @Req() req: Request) {
    return this.system.setAccepting(dto.accepting_orders, actor(req));
  }

  @Get('dashboard')
  snapshot() {
    return this.dashboard.snapshot();
  }

  @Get('alerts')
  alerts(@Query('limit') limit = '50') {
    return this.db.query('SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT $1', [
      Math.min(Number(limit) || 50, 200),
    ]);
  }

  @Get('audit-logs')
  auditLogs(@Query('limit') limit = '50') {
    return this.db.query('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT $1', [
      Math.min(Number(limit) || 50, 200),
    ]);
  }
}

@ApiTags('deploy')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller()
export class DeployController {
  constructor(private readonly deploy: DeployService) {}

  @Post('packages')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PACKAGE_BYTES + 1 } }))
  async upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { package: pkg, created } = await this.deploy.upload(file?.originalname ?? 'package.zip', file?.buffer, actor(req));
    res.status(created ? 201 : 200);
    return pkg;
  }

  @Get('packages')
  list() {
    return this.deploy.listPackages();
  }

  @Delete('packages/:id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    await this.deploy.deletePackage(String(id), actor(req));
  }

  /** อัปเดตโค้ดทุกเครื่อง (bot_ids ว่าง) หรือเลือกเครื่อง */
  @Post('packages/:id/deploy')
  @HttpCode(202)
  deployPackage(@Param('id', ParseIntPipe) id: number, @Body() dto: DeployDto, @Req() req: Request) {
    return this.deploy.deploy(String(id), dto.bot_ids, actor(req));
  }

  @Get('deployments')
  deployments() {
    return this.deploy.recentDeployments(50);
  }
}
