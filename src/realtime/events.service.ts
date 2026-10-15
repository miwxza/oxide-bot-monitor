import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type AgentMessage =
  | { type: 'system'; acceptingOrders: boolean }
  | { type: 'wake' } // มีงานใหม่เข้าคิว
  | { type: 'deploy'; deploymentId: string; packageId: string; sha256: string; filename: string };

/** ส่งข้อความถึง agent ที่ต่อ WebSocket อยู่ — คืน true ถ้าส่งถึงอย่างน้อย 1 เครื่อง */
export type AgentSender = (botId: string, msg: AgentMessage) => boolean;

/**
 * event bus ภายใน process
 * - 'changed': สถานะบางอย่างเปลี่ยน → dashboard ส่ง snapshot ใหม่
 * - toAgent(): ส่งข้อความหา bot agent (botId = '*' คือทุกเครื่อง)
 */
@Injectable()
export class EventsService extends EventEmitter {
  private sender: AgentSender = () => false;

  setAgentSender(sender: AgentSender): void {
    this.sender = sender;
  }

  changed(reason: string): void {
    this.emit('changed', reason);
  }

  toAgent(botId: string, msg: AgentMessage): boolean {
    return this.sender(botId, msg);
  }
}
