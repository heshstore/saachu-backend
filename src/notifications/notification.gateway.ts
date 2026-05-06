import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { Notification } from './notification.entity';

@WebSocketGateway({ cors: true })
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket): void {
    const userId = Number(client.handshake.query.userId);
    if (userId && !isNaN(userId)) {
      client.join(`user_${userId}`);
      this.logger.log(`Connected: userId=${userId} socket=${client.id}`);
    } else {
      this.logger.warn(`Connected without userId: socket=${client.id}`);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Disconnected: socket=${client.id}`);
  }

  sendToUser(userId: number, notification: Notification): void {
    this.server.to(`user_${userId}`).emit('notification.new', notification);
  }

  @OnEvent('notification.created')
  handleNotificationCreated(payload: { userId: number; notification: Notification }): void {
    this.sendToUser(payload.userId, payload.notification);
  }
}
