import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { MessagesService } from './messages.service.js';
import { EditMessageDto } from './dto/edit-message.dto.js';

// Auth is a stated non-goal for this phase (architecture §0). One operator, named here, until
// Keycloak/OIDC is wired — at which point this is replaced by the authenticated principal.
const DECIDED_BY = 'Minh Tran';

@Controller('api/accounts/:accountId/messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

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
