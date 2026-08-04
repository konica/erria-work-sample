import { Body, Controller, Logger, Param, Patch, Post } from '@nestjs/common';
import { MessagesService } from './messages.service.js';
import { EditMessageDto } from './dto/edit-message.dto.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';

// Auth is a stated non-goal for this phase (architecture §0). One operator, named here, until
// Keycloak/OIDC is wired — at which point this is replaced by the authenticated principal.
const DECIDED_BY = 'Minh Tran';

@Controller('api/accounts/:accountId/messages')
export class MessagesController {
  private readonly logger = new Logger(MessagesController.name);

  constructor(
    private readonly messagesService: MessagesService,
    private readonly workerClient: WorkerClient,
  ) {}

  @Patch(':messageId')
  async edit(
    @Param('accountId') accountId: string,
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
  ) {
    const message = await this.messagesService.editDraft(accountId, messageId, dto.body);
    return {
      message: {
        id: message.id,
        body: message.body,
        edited: message.edited,
        originalBody: message.originalBody,
      },
    };
  }

  @Post(':messageId/reject')
  async reject(@Param('accountId') accountId: string, @Param('messageId') messageId: string) {
    const message = await this.messagesService.rejectDraft(accountId, messageId, DECIDED_BY);
    return { message: { id: message.id, status: message.status } };
  }

  @Post(':messageId/approve')
  async approve(@Param('accountId') accountId: string, @Param('messageId') messageId: string) {
    const message = await this.messagesService.approveDraft(accountId, messageId, DECIDED_BY);

    // Deliberately not awaited: the human-facing request returns as soon as the decision is
    // recorded (architecture §3). If this call fails, the message sits 'approved' with no sentAt —
    // which is exactly what the reconciliation sweep looks for.
    void this.workerClient.dispatchMessage(message.id).catch((error: unknown) => {
      this.logger.error(`Async dispatch failed for message ${message.id}`, error);
    });

    return {
      message: {
        id: message.id,
        status: message.status,
        decidedBy: message.decidedBy,
        decidedAt: message.decidedAt,
      },
    };
  }
}
