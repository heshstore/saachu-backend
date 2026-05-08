import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { ActivityLog } from './entities/activity-log.entity';

// Reuses the same Socket.io server namespace but adds an `activity` room
// so clients subscribed to global activity receive realtime pushes.
@WebSocketGateway({ cors: true })
export class ActivityGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ActivityGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket): void {
    // Clients join 'activity_feed' room to receive global activity events
    if (client.handshake.query.activityFeed === 'true') {
      client.join('activity_feed');
      this.logger.debug(`Activity feed subscriber: socket=${client.id}`);
    }
  }

  handleDisconnect(_client: Socket): void {}

  @OnEvent('activity.created')
  handleActivityCreated(log: ActivityLog): void {
    this.server.to('activity_feed').emit('activity.new', log);
  }
}
