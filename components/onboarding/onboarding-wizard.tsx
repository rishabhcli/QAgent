'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, 
  ArrowRight, 
  ArrowLeft, 
  Sparkles, 
  Rocket, 
  TestTube2, 
  GitBranch,
  CheckCircle,
  Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  gradient: string;
}

const steps: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to PatchPilot',
    description: 'Your AI-powered QA agent that automatically tests, detects bugs, and fixes them. Let\'s take a quick tour!',
    icon: Zap,
    gradient: 'from-violet-500 to-purple-600',
  },
  {
    id: 'tests',
    title: 'Define Test Specs',
    description: 'Create test specifications using natural language. Describe what to test and PatchPilot will run them against your app.',
    icon: TestTube2,
    gradient: 'from-emerald-500 to-teal-600',
  },
  {
    id: 'runs',
    title: 'Start Test Runs',
    description: 'Launch a run to trigger the agent loop. PatchPilot will test your app, detect failures, and generate fixes automatically.',
    icon: Rocket,
    gradient: 'from-blue-500 to-cyan-600',
  },
  {
    id: 'patches',
    title: 'Review & Apply Patches',
    description: 'Review generated patches before deploying. Track all fixes in the patches history and learn from past improvements.',
    icon: GitBranch,
    gradient: 'from-orange-500 to-amber-600',
  },
  {
    id: 'ready',
    title: 'You\'re All Set!',
    description: 'Start by connecting your GitHub repository and creating your first test spec. PatchPilot is ready to heal your codebase.',
    icon: Sparkles,
    gradient: 'from-pink-500 to-rose-600',
  },
];

const STORAGE_KEY = 'qagent_onboarding_complete';

export function OnboardingWizard() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Check localStorage safely after mount
    try {
      const completed = localStorage.getItem(STORAGE_KEY);
      if (!completed) {
        // Show onboarding after a short delay for better UX
        const timer = setTimeout(() => setIsOpen(true), 1000);
        return () => clearTimeout(timer);
      }
    } catch {
      // localStorage not available, skip onboarding
    }
  }, []);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleComplete = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // localStorage not available
    }
    setIsOpen(false);
  };

  const handleSkip = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // localStorage not available
    }
    setIsOpen(false);
  };

  if (!mounted || !isOpen) return null;

  const step = steps[currentStep];
  const Icon = step.icon;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Modal */}
          <motion.div
            className="fixed inset-0 z-[201] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="relative w-full max-w-lg rounded-3xl border border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl overflow-hidden"
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              transition={{ type: 'spring', duration: 0.5 }}
            >
              {/* Close Button */}
              <button
                onClick={handleSkip}
                className="absolute top-4 right-4 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors z-10"
                aria-label="Skip onboarding"
              >
                <X className="h-4 w-4" />
              </button>

              {/* Content */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3 }}
                  className="p-8"
                >
                  {/* Icon */}
                  <motion.div 
                    className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${step.gradient} flex items-center justify-center mb-6 mx-auto`}
                    initial={{ scale: 0.5, rotate: -10 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', duration: 0.5 }}
                  >
                    <Icon className="h-10 w-10 text-white" />
                  </motion.div>

                  {/* Text */}
                  <h2 className="text-2xl font-bold text-center mb-3">
                    {step.title}
                  </h2>
                  <p className="text-muted-foreground text-center max-w-sm mx-auto">
                    {step.description}
                  </p>
                </motion.div>
              </AnimatePresence>

              {/* Footer */}
              <div className="px-8 pb-8">
                {/* Progress Dots */}
                <div className="flex justify-center gap-2 mb-6">
                  {steps.map((s, i) => (
                    <button
                      key={s.id}
                      onClick={() => setCurrentStep(i)}
                      className={`h-2 rounded-full transition-all duration-300 ${
                        i === currentStep 
                          ? 'w-8 bg-primary' 
                          : i < currentStep 
                            ? 'w-2 bg-primary/50' 
                            : 'w-2 bg-secondary'
                      }`}
                      aria-label={`Go to step ${i + 1}`}
                    />
                  ))}
                </div>

                {/* Navigation Buttons */}
                <div className="flex items-center justify-between gap-4">
                  <Button
                    variant="ghost"
                    onClick={currentStep === 0 ? handleSkip : handlePrev}
                    className="text-muted-foreground"
                  >
                    {currentStep === 0 ? (
                      'Skip tour'
                    ) : (
                      <>
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back
                      </>
                    )}
                  </Button>

                  <Button 
                    onClick={handleNext}
                    className={`bg-gradient-to-r ${step.gradient} hover:opacity-90`}
                  >
                    {currentStep === steps.length - 1 ? (
                      <>
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Get Started
                      </>
                    ) : (
                      <>
                        Next
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
