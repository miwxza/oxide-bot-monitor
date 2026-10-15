import { DynamicModule, Module } from '@nestjs/common';
import { AdminGuard, AgentGuard } from './common/auth';
import { AgentController } from './api/agent.controller';
import { BotsController, DeployController, OrdersController, SystemController } from './api/admin.controller';
import { DevController, WebhooksController } from './api/webhooks.controller';
import { WorkService } from './agent/work.service';
import { BotsService } from './bots/bots.service';
import { CommandsService } from './bots/commands.service';
import { SimulatorClient } from './bots/simulator.client';
import { AppConfig, CONFIG } from './config';
import { DbService } from './db/db.service';
import { DeployService } from './deploy/deploy.service';
import { JobsService } from './jobs/jobs.service';
import { OrdersService } from './orders/orders.service';
import { DashboardService } from './realtime/dashboard.service';
import { EventsService } from './realtime/events.service';
import { RealtimeService } from './realtime/realtime.service';
import { SystemService } from './system/system.service';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [OrdersController, BotsController, SystemController, DeployController, AgentController, WebhooksController, DevController],
      providers: [
        { provide: CONFIG, useValue: cfg },
        AdminGuard,
        AgentGuard,
        DbService,
        EventsService,
        SystemService,
        OrdersService,
        WebhooksService,
        WorkService,
        BotsService,
        SimulatorClient,
        CommandsService,
        DeployService,
        DashboardService,
        RealtimeService,
        JobsService,
      ],
    };
  }
}
