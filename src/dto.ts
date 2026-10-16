import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
} from 'class-validator';
import { BOT_COMMANDS } from './bots/commands.service';

export class CreateOrderDto {
  @ApiProperty({ example: 'SHOP-20261015-0001', description: 'เลขออเดอร์ของร้าน — ใช้เป็น idempotency key' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,64}$/)
  external_order_id: string;

  @ApiProperty({ example: '12345678', description: 'UID ผู้เล่น (ค่าพิเศษสำหรับ demo ดู README)' })
  @IsString()
  @Length(3, 32)
  player_uid: string;

  @ApiProperty({ example: 'AOEM-99' })
  @IsString()
  @Length(1, 64)
  package_code: string;

  @ApiProperty({ example: 146 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000)
  amount: number;

  @ApiPropertyOptional({ example: 'THB', default: 'THB' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}

export class ResolveOrderDto {
  @ApiProperty({ enum: ['COMPLETED', 'FAILED'] })
  @IsIn(['COMPLETED', 'FAILED'])
  outcome: 'COMPLETED' | 'FAILED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class NoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PaymentWebhookDto {
  @ApiProperty({ example: 'evt_001' })
  @IsString()
  @Length(1, 128)
  event_id: string;

  @ApiProperty({ example: 'SHOP-20261015-0001' })
  @IsString()
  external_order_id: string;

  @ApiProperty({ example: 'TXN-0001' })
  @IsString()
  @Length(1, 128)
  transaction_id: string;

  @ApiProperty({ example: 146 })
  @IsNumber()
  amount: number;

  @ApiProperty({ example: '2026-10-15T08:00:00Z', description: 'เวลาที่ธนาคารรับเงิน (ใช้ตัดสินว่าจ่ายทันไหม)' })
  @IsDateString()
  paid_at: string;
}

export class CommandDto {
  @ApiProperty({ enum: BOT_COMMANDS })
  @IsIn(BOT_COMMANDS as unknown as string[])
  command: (typeof BOT_COMMANDS)[number];
}

export class KillSwitchDto {
  @ApiProperty({ description: 'false = ปิดทั้งระบบ (kill-switch), true = เปิดรับงาน' })
  @IsBoolean()
  accepting_orders: boolean;
}

export class DeployDto {
  @ApiPropertyOptional({ type: [String], description: 'ไม่ส่ง/ว่าง = ทุกเครื่อง' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  bot_ids?: string[];
}

export class LeaseDto {
  @ApiProperty()
  @IsString()
  lease_token: string;
}

export class CompleteDto extends LeaseDto {
  @ApiPropertyOptional({ example: 'oxide-bot@2.0.0', description: 'โค้ดบอท (จากแพ็กเกจ) ที่ทำงานนี้ — บันทึกใน timeline' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bot_version?: string;
}

export class FailDto extends LeaseDto {
  @ApiProperty({ example: 'PROVIDER_TIMEOUT' })
  @IsString()
  @Matches(/^[A-Z0-9_]{2,64}$/)
  code: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class ProviderTopupDto {
  @ApiProperty()
  @IsString()
  topup_key: string;

  @ApiProperty()
  @IsString()
  external_order_id: string;
}

export class DevPayDto {
  @ApiPropertyOptional({ description: 'จำลองจ่ายหลังหมดเวลา' })
  @IsOptional()
  @IsBoolean()
  late?: boolean;

  @ApiPropertyOptional({ description: 'ยอดที่จ่าย (ค่าเริ่มต้น = ยอดออเดอร์)' })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiPropertyOptional({ description: 'ใช้ transaction_id เดิมซ้ำ' })
  @IsOptional()
  @IsString()
  transaction_id?: string;
}
