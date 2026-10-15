import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { AdminGuard } from '../common/auth';
import { AppConfig, CONFIG } from '../config';
import { DevPayDto, PaymentWebhookDto } from '../dto';
import { OrdersService } from '../orders/orders.service';
import { WebhooksService } from '../webhooks/webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /** ธนาคารแจ้งชำระเงิน — ตรวจ HMAC-SHA256 ของ raw body ใน header X-Signature: sha256=<hex> */
  @Post('payment')
  @HttpCode(200)
  @ApiHeader({ name: 'X-Signature', required: true })
  payment(@Req() req: RawBodyRequest<Request>, @Body() dto: PaymentWebhookDto, @Headers('x-signature') sig?: string) {
    this.webhooks.verifySignature(req.rawBody, sig);
    return this.webhooks.handlePayment(dto);
  }
}

/** สำหรับ demo เท่านั้น: จำลองธนาคารส่ง webhook */
@ApiTags('dev')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller('dev')
export class DevController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly orders: OrdersService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post('orders/:id/pay')
  @HttpCode(200)
  async pay(@Param('id') id: string, @Body() dto: DevPayDto) {
    const order = await this.orders.get(id);
    const paidAt = dto.late
      ? new Date(new Date(order.payment_expires_at).getTime() + 60_000)
      : new Date();
    const payload = {
      event_id: 'evt_' + randomBytes(6).toString('hex'),
      external_order_id: id,
      transaction_id: dto.transaction_id ?? 'TXN-' + randomBytes(6).toString('hex').toUpperCase(),
      amount: dto.amount ?? Number(order.amount),
      paid_at: paidAt.toISOString(),
    };
    return { webhook: payload, result: await this.webhooks.handlePayment(payload) };
  }
}
