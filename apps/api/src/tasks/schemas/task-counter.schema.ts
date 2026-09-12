import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type TaskCounterDocument = HydratedDocument<TaskCounter>;

/**
 * One row per project (`_id` is the project's id, not a generated one),
 * holding the last task number issued for it. Never read directly — always
 * updated via `findOneAndUpdate` + `$inc`, which MongoDB performs as a
 * single atomic document operation. That's what makes numbering
 * concurrency-safe without a multi-document transaction: there's no
 * separate "read the current value" step for two requests to race on, so
 * two concurrent task creations always get two distinct, gap-free numbers.
 */
@Schema({ collection: 'task_counters' })
export class TaskCounter {
  @Prop({ required: true, default: 0, min: 0 })
  seq: number;
}

export const TaskCounterSchema = SchemaFactory.createForClass(TaskCounter);
