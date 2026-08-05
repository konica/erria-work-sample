import { IsIn, IsString, MinLength } from 'class-validator';

export class ChangeTierDto {
  // Tier 1 is deliberately absent: it is earned via clean approvals, never set by hand (ADR-0004).
  @IsIn([2, 3]) tier!: 2 | 3;
  @IsString() @MinLength(1) reason!: string;
}
