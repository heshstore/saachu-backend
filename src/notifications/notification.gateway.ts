import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { Notification } from './notification.entity';

@WebSocketGateway({ cors: true })
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket): void {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      this.logger.warn(`WS rejected: no token socket=${client.id}`);
      client.disconnect(true);
      return;
    }
    let payload: { sub: number } & Record<string, unknown>;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      this.logger.warn(`WS rejected: invalid token socket=${client.id}`);
      client.disconnect(true);
      return;
    }
    const userId = Number(payload.sub);
    if (!userId || isNaN(userId)) {
      this.logger.warn(`WS rejected: no sub in token socket=${client.id}`);
      client.disconnect(true);
      return;
    }
    client.join(`user_${userId}`);
    this.logger.log(`Connected: userId=${userId} socket=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Disconnected: socket=${client.id}`);
  }

  sendToUser(userId: number, notification: Notification): void {
    this.server.to(`user_${userId}`).emit('notification.new', notification);
  }

  @OnEvent('notification.created')
  handleNotificationCreated(payload: {
    userId: number;
    notification: Notification;
  }): void {
    this.sendToUser(payload.userId, payload.notification);
  }
}
