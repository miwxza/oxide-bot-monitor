import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { AllExceptionsFilter, requestId } from './common/errors';
import { AppConfig } from './config';
import { DbService } from './db/db.service';
import { JobsService } from './jobs/jobs.service';
import { RealtimeService } from './realtime/realtime.service';

/** สร้างแอป (ใช้ทั้ง main.ts และเทสต์) — migrate DB ก่อนรับ request */
export async function createApp(cfg: AppConfig, opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    rawBody: true, // ต้องใช้ raw body ตรวจ signature ของ webhook
    logger: opts.logger === false ? false : ['log', 'warn', 'error'],
  });
  app.use(requestId);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useStaticAssets(join(process.cwd(), 'public'));

  const doc = new DocumentBuilder()
    .setTitle('Oxide Bot Monitor API')
    .setDescription('Central bot monitoring, control and order tracking')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Admin-Token' }, 'admin')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Agent-Token' }, 'agent')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  await app.get(DbService).migrate();
  app.get(RealtimeService).attach(app.getHttpServer());
  if (cfg.runJobs) app.get(JobsService).start();
  return app;
}
