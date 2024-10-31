import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WebinarPlan, WebinarPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";

interface Props {
    onNext: (data: WebinarPlan[]) => void;
    onBack: () => void;
    initialData: WebinarPlan[];
}

const WebinarPlanFormSchema = z.object({
    plans: WebinarPlanSchema.array().min(1, "At least one webinar plan is required"),
});

type FormData = z.infer<typeof WebinarPlanFormSchema>;

const WebinarPlanForm: React.FC<Props> = ({
    onNext,
    onBack,
    initialData,
}) => {
    const {
        register,
        control,
        handleSubmit,
        formState: { errors, isSubmitting },
    } = useForm<FormData>({
        resolver: zodResolver(WebinarPlanFormSchema),
        defaultValues: { 
            plans: initialData.length 
                ? initialData 
                : [{ 
                    id: crypto.randomUUID(),
                    title: "",
                    description: "",
                    price: 0,
                    durationInHours: 1,
                    maxParticipants: 100,
                    language: "English",
                    level: "Beginner",
                    prerequisites: "",
                    materialProvided: "",
                    learningOutcomes: [],
                    topics: []
                }] 
        },
    });

    const { fields, append, remove } = useFieldArray({
        control,
        name: "plans",
    });

    const onSubmit = async (data: FormData) => {
        console.log("Form submitted:", data);
        try {
            onNext(data.plans);
            console.log("onNext function called successfully");
        } catch (error) {
            console.error("Error in onNext function:", error);
        }
    };

    return (
        <form
            onSubmit={handleSubmit(onSubmit)}
            className="w-full max-w-md space-y-4"
        >
            <h2 className="text-xl font-bold">Webinar Plans</h2>
            {fields.map((field, index) => (
                <div key={field.id} className="space-y-2 p-4 border rounded">
                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.title`}>Title</Label>
                        <Input
                            id={`plans.${index}.title`}
                            type="text"
                            {...register(`plans.${index}.title` as const)}
                        />
                        {errors.plans && errors.plans[index]?.title?.message && (
                            <p className="text-red-500">{errors.plans[index]?.title?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.description`}>Description</Label>
                        <Input
                            id={`plans.${index}.description`}
                            type="text"
                            {...register(`plans.${index}.description` as const)}
                        />
                        {errors.plans && errors.plans[index]?.description?.message && (
                            <p className="text-red-500">{errors.plans[index]?.description?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.durationInHours`}>Duration (hours)</Label>
                        <Input
                            id={`plans.${index}.durationInHours`}
                            type="number"
                            step="0.5"
                            {...register(`plans.${index}.durationInHours` as const, { valueAsNumber: true })}
                        />
                        {errors.plans && errors.plans[index]?.durationInHours?.message && (
                            <p className="text-red-500">{errors.plans[index]?.durationInHours?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.price`}>Price (cents)</Label>
                        <Input
                            id={`plans.${index}.price`}
                            type="number"
                            {...register(`plans.${index}.price` as const, { valueAsNumber: true })}
                        />
                        {errors.plans && errors.plans[index]?.price?.message && (
                            <p className="text-red-500">{errors.plans[index]?.price?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.maxParticipants`}>Max Participants</Label>
                        <Input
                            id={`plans.${index}.maxParticipants`}
                            type="number"
                            {...register(`plans.${index}.maxParticipants` as const, { valueAsNumber: true })}
                        />
                        {errors.plans && errors.plans[index]?.maxParticipants?.message && (
                            <p className="text-red-500">{errors.plans[index]?.maxParticipants?.message}</p>
                        )}
                    </div>

                    {fields.length > 1 && (
                        <Button type="button" onClick={() => remove(index)} variant="outline">
                            Remove Plan
                        </Button>
                    )}
                </div>
            ))}

            <Button
                type="button"
                onClick={() => append({
                    id: crypto.randomUUID(),
                    title: "",
                    description: "",
                    price: 0,
                    durationInHours: 1,
                    maxParticipants: 100,
                    language: "English",
                    level: "Beginner",
                    prerequisites: "",
                    materialProvided: "",
                    learningOutcomes: [],
                    topics: []
                })}
                variant="outline"
            >
                Add Plan
            </Button>

            {errors.plans?.root && (
                <p className="text-red-500">{errors.plans.root.message}</p>
            )}

            <div className="flex justify-between">
                <Button type="button" onClick={onBack} variant="outline">
                    Back
                </Button>
                <Button type="submit" variant="night" disabled={isSubmitting}>
                    {isSubmitting ? 'Submitting...' : 'Next'}
                </Button>
            </div>

            {Object.keys(errors).length > 0 && (
                <p className="text-red-500">
                    Please correct the errors in the form before submitting.
                </p>
            )}
        </form>
    );
};

export default WebinarPlanForm;
