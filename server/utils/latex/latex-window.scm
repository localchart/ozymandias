(define-structure (latex-window (constructor silently-make-latex-window (#!optional name)))
  (name (string-append "latex-window-" (number->string (get-id))) read-only #t))

(define (make-latex-window #!optional name latex)
  (define latex-window (silently-make-latex-window name latex))
  (send-latex-window latex-window #t)
  latex-window)

(define (latex-window->json latex-window #!optional latex)
  (assert (latex-window? latex-window))
  (dict->json `((name ,(latex-window-name latex-window))
                (type latex)
                (latex ,(if (default-object? latex) "" latex)))))

(define (re expression #!optional latex-window)
  (let ((latex-window (if (latex-window? latex-window) latex-window (silently-make-latex-window)))
        (expression (cond ((literal-number? expression) (simplify expression))
                           ((literal-function? expression) (simplify expression))
                           (else expression))))
    (send-latex-window latex-window (expression->tex-string expression) #t)
    latex-window))

(define (send-latex-window latex-window #!optional latex push)
  (assert (latex-window? latex-window))
  (send-json (latex-window->json latex-window latex) push))
